/**
 * The AI layer of the trap detection: the AI sub-task `traps`, registered before `score`, so the scoring of the same
 * cycle already gets the cleaned JD. It reports what the rules do not know and judges the rule findings. What the AI may change:
 * a suspicious finding becomes a trap ("confirmed") or harmless ("benign"); a rule trap it doubts stays a trap ("disputed", with
 * the reason shown). Every quote it gives must be the JD's or a hidden text's own text (C7), else it is dropped.
 */
import { AiProviderError, AiUnavailableError } from "@/lib/ai/errors";
import { buildTrapsPrompt, TRAPS_PROMPT_VERSION, trapsOutputSchema, type TrapCandidate, type TrapsOutput } from "@/lib/ai/prompts/traps";
import { registerAiSubtask, type AiSubtask, type AiSubtaskContext } from "@/lib/ai/step";
import { aiOutputLanguage } from "@/lib/i18n/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Db } from "@/lib/db/client";
import { getTrapCheckInput, listJobsToTrapCheck, saveTrapAiCheck, trapTablesReady, type JobTrapRow, type SaveTrapAiCheckInput, type TrapInsert } from "@/lib/db/repos/traps";

import { locateLoose } from "./locate";
import { readTrapsSettings } from "./settings";

export const TRAPS_SUBTASK_NAME = "traps";

/** A rule finding as the merge needs it. */
export type RuleRow = Pick<JobTrapRow, "id" | "technique" | "method" | "severity" | "quote" | "quoteSource" | "quoteOffset" | "location" | "rawPostingId" | "detail">;

/** The candidates the model judges: every rule finding, numbered from 1 in row order (tag characters as their decoded text). */
export function trapCandidates(rules: readonly RuleRow[]): TrapCandidate[] {
  return rules.map((row, index) => {
    const decoded = typeof (row.detail as Record<string, unknown> | null)?.decoded === "string" ? ((row.detail as Record<string, string>).decoded as string) : null;
    return { id: index + 1, technique: row.technique, method: row.method, text: decoded ?? row.quote };
  });
}

export interface MergedCheck {
  verdicts: SaveTrapAiCheckInput["verdicts"];
  findings: TrapInsert[];
  /** Quotes that are neither in the JD nor in a hidden text (dropped, C7). */
  dropped: number;
}

function overlapsRow(row: RuleRow, start: number, end: number): boolean {
  return row.quoteSource === "description" && row.quoteOffset !== null && start < row.quoteOffset + row.quote.length && end > row.quoteOffset;
}

/**
 * Turn the model's answer into verdicts on the rule findings and new AI findings. Pure. Verdicts by candidate id; a reported trap
 * that lies on a rule finding confirms that finding instead of adding a second one.
 */
export function mergeTrapAiCheck(input: { description: string; rules: readonly RuleRow[]; output: TrapsOutput }): MergedCheck {
  const { description, rules, output } = input;
  const verdicts = new Map<number, { verdict: "confirmed" | "benign" | "disputed"; reason: string }>();
  for (const review of output.reviewed) {
    const row = rules[review.id - 1];
    if (!row) continue;
    // the AI cannot revoke a rule trap: a "benign" on it is kept as its differing view
    const verdict = review.verdict === "trap" ? "confirmed" : row.severity === "trap" ? "disputed" : "benign";
    verdicts.set(row.id, { verdict, reason: review.reason });
  }

  const findings: TrapInsert[] = [];
  let dropped = 0;
  for (const trap of output.traps) {
    const inJd = locateLoose(description, trap.quote);
    if (inJd) {
      const host = rules.find((row) => overlapsRow(row, inJd.start, inJd.end));
      if (host) {
        verdicts.set(host.id, { verdict: "confirmed", reason: trap.reason });
        continue;
      }
      if (findings.some((f) => f.quoteOffset !== null && inJd.start < f.quoteOffset + f.quote.length && inJd.end > f.quoteOffset)) continue;
      findings.push({
        // a visible quote is not hidden text, whatever the model called it
        technique: trap.technique === "hidden_text" ? "instruction" : trap.technique,
        method: null,
        severity: "trap",
        quote: description.slice(inJd.start, inJd.end),
        quoteSource: "description",
        quoteOffset: inJd.start,
        location: "description",
        rawPostingId: null,
        evidence: null,
        detail: {},
        inDescription: true,
        reason: trap.reason,
      });
      continue;
    }
    // a quote of a hidden text that only the source page has: it confirms that hidden finding
    const hidden = rules.find((row) => row.quoteSource === "raw" && (row.quote.includes(trap.quote.trim()) || locateLoose(row.quote, trap.quote) !== null));
    if (hidden) {
      verdicts.set(hidden.id, { verdict: "confirmed", reason: trap.reason });
      continue;
    }
    dropped += 1;
  }
  return { verdicts: [...verdicts.entries()].map(([id, v]) => ({ id, ...v })), findings, dropped };
}

export interface TrapCheckResult {
  skipped?: "disabled" | "off" | "config_error" | "dry run" | "no database" | "no_tables";
  mode: TrapsConfig["ai_check"]["mode"] | null;
  candidates: number;
  checked: number;
  /** Rule findings the AI confirmed / judged harmless / doubted (rule traps stay traps). */
  confirmed: number;
  benign: number;
  disputed: number;
  /** Findings only the AI made. */
  added: number;
  /** Quotes the model gave that are not in the JD or a hidden text (C7). */
  droppedQuotes: number;
  failed: number;
  /** The JD changed while the AI worked: the next cycle checks it again. */
  skippedJobs: number;
  stopped: "cancelled" | "ai_unavailable" | null;
}

export interface TrapCheckDeps {
  loadSettings(): TrapsConfig | null;
  /** The language of the AI's reasons (`language.yaml: ai.output`); default: read from the file. */
  outputLanguage?(): string;
}

const defaultDeps: TrapCheckDeps = { loadSettings: () => readTrapsSettings(), outputLanguage: () => aiOutputLanguage() };

/** Whether a failure belongs to this job only (every provider answered, none validly): the next job may work. */
function isJobSpecific(error: unknown): boolean {
  if (!(error instanceof AiUnavailableError)) return false;
  const failed = error.attempts.filter((a) => a.outcome === "failed");
  return failed.length > 0 && failed.every((a) => a.kind === "invalid_output");
}

/** Check the picked jobs one after another. Off / disabled / unreadable config return an ordinary result with `skipped`. */
export async function runTrapAiCheck(ctx: AiSubtaskContext, deps: TrapCheckDeps = defaultDeps): Promise<TrapCheckResult> {
  const result: TrapCheckResult = { mode: null, candidates: 0, checked: 0, confirmed: 0, benign: 0, disputed: 0, added: 0, droppedQuotes: 0, failed: 0, skippedJobs: 0, stopped: null };
  const settings = deps.loadSettings();
  if (settings === null) return { ...result, skipped: "config_error" };
  if (!settings.enabled) return { ...result, skipped: "disabled" };
  result.mode = settings.ai_check.mode;
  if (settings.ai_check.mode === "off") return { ...result, skipped: "off" };
  const db: Db | null = ctx.cycle.db;
  if (ctx.cycle.dryRun || db === null) return { ...result, skipped: ctx.cycle.dryRun ? "dry run" : "no database" };
  if (!(await trapTablesReady(db))) return { ...result, skipped: "no_tables" };

  const jobs = await listJobsToTrapCheck(db, { mode: settings.ai_check.mode, promptVersion: TRAPS_PROMPT_VERSION, limit: settings.ai_check.per_cycle_limit });
  result.candidates = jobs.length;
  for (const { jobId } of jobs) {
    if (ctx.cycle.signal.aborted) {
      result.stopped = "cancelled";
      break;
    }
    const input = await getTrapCheckInput(db, jobId);
    if (!input) continue;
    const prompt = buildTrapsPrompt({ title: input.title, company: input.company, description: input.description, candidates: trapCandidates(input.rules), jdMaxChars: settings.ai_check.jd_max_chars, outputLanguage: (deps.outputLanguage ?? defaultDeps.outputLanguage)?.() });
    let answer;
    try {
      answer = await ctx.router.run("traps", prompt, trapsOutputSchema, { jobId, signal: ctx.cycle.signal });
    } catch (error) {
      if ((error instanceof AiProviderError && error.kind === "aborted") || ctx.cycle.signal.aborted) {
        result.stopped = "cancelled";
        break;
      }
      result.failed += 1;
      ctx.cycle.logger.warn("ai trap check failed for a job", { jobId, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error" });
      if (!isJobSpecific(error)) {
        result.stopped = "ai_unavailable";
        break;
      }
      continue;
    }
    const merged = mergeTrapAiCheck({ description: input.description, rules: input.rules, output: answer.value });
    const stored = await saveTrapAiCheck(db, {
      jobId,
      descriptionHash: input.descriptionHash,
      promptVersion: TRAPS_PROMPT_VERSION,
      provider: answer.provider,
      model: answer.model,
      verdicts: merged.verdicts,
      findings: merged.findings,
    });
    if (!stored) {
      result.skippedJobs += 1;
      continue;
    }
    result.checked += 1;
    result.added += merged.findings.length;
    result.droppedQuotes += merged.dropped;
    for (const v of merged.verdicts) result[v.verdict] += 1;
    ctx.cycle.logger.info("ai trap check done", { jobId, provider: answer.provider, added: merged.findings.length, verdicts: merged.verdicts.length, dropped: merged.dropped });
  }
  return result;
}

export const trapsAiSubtask: AiSubtask = { name: TRAPS_SUBTASK_NAME, run: (ctx) => runTrapAiCheck(ctx) };

/** Plug the `traps` sub-task into the `ai` step; `registerBuiltinAiSubtasks` calls it before the scoring. */
export function registerTrapsAiSubtask(): void {
  registerAiSubtask(trapsAiSubtask);
}
