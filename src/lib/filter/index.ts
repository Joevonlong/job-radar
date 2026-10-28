import { createHash } from "node:crypto";

import type { CycleStepContext, StepResult } from "@/lib/cycle/steps";
import { registerCycleStep } from "@/lib/cycle/steps";
import { loadConfig, parseConfigText, readProfileText, type MeConfig, type PipelineConfig, type PreferencesConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import {
  getFilterResults,
  insertFilterResults,
  listFilterCandidates,
  updateFilterResult,
  type FilterCandidate,
  type NewFilterResult,
  type ProfileSnapshot,
} from "@/lib/db";
import { asGermanLevel, parseLocations, parseSalary } from "@/lib/db/queries/parse";
import { snapshotForProfileText } from "@/lib/profile/snapshots";
import type { ChannelLogger } from "@/lib/channels/types";

import { dealBreakerVetoes, startDealBreakerRun, type DealBreakerMe, type DealBreakerRun, type DealBreakerWarning, type TimeBox } from "./deal-breakers";
import { dealBreakerIds } from "./reasons";
import { compileFilter, evaluateJob, type CompiledFilter, type FilterJob, type FilterOverride, type FilterVerdict } from "./rules";
import { vmTimeBox } from "./time-box";

export { applyOverride, compileFilter, evaluateJob, foldText, wholeWordPattern, type CompiledFilter, type FilterContext, type FilterJob, type FilterOverride, type FilterResult, type FilterVerdict } from "./rules";
export * from "./reasons";
export { compileDealBreakers, explainDealBreaker, type DealBreakerContext, type DealBreakerExplanation, type DealBreakerWarning } from "./deal-breakers";
export { vmTimeBox } from "./time-box";

export interface FilterRunResult {
  /** The preferences snapshot the results belong to. */
  snapshotId: number;
  /** Jobs looked at (not closed). */
  evaluated: number;
  /** New (job, snapshot) results. */
  created: number;
  /** Existing results whose outcome changed because the job changed. */
  updated: number;
  /** Existing results that were already right: nothing written. */
  unchanged: number;
  passed: number;
  filteredOut: number;
  /** How often each reason code applies over all evaluated jobs. */
  byReason: Record<string, number>;
  aborted: boolean;
  /**
   * Deal-breakers that did nothing in this run, or stopped part way: written but not applicable (no language step, me.yaml
   * unreadable, over the limits) or too slow (on the test texts, or over `rule_budget_ms` during the run).
   */
  dealBreakerWarnings: DealBreakerWarning[];
}

export interface FilterOptions {
  preferences: PreferencesConfig;
  /** The snapshot `preferences` was saved as. */
  snapshotId: number;
  pipeline: PipelineConfig;
  /** me.yaml for a language gate (`currentPreferences().me`); null when it cannot be read: a gate without `at_least` then does nothing and is reported. */
  me: DealBreakerMe | null;
  /** Force these jobs (the user changed a decision); default: changed inputs, or all eligible jobs for timed deal-breakers. */
  jobIds?: readonly number[];
  logger?: ChannelLogger;
  signal?: AbortSignal;
  /** Where the user's patterns run (default `vmTimeBox`); tests pass their own. */
  timeBox?: TimeBox;
  /** `interests.yaml: watched_companies`; default: read from the file (`currentWatchedCompanies`), so every caller judges alike. */
  watchedCompanies?: readonly string[];
}

/**
 * The watch list of interests.yaml as it is now. An unreadable file gives an empty list (and a warning): the database flag
 * `companies.watched` still watches its companies.
 */
export function currentWatchedCompanies(logger?: ChannelLogger): string[] {
  try {
    return [...loadConfig("interests").watched_companies];
  } catch (error) {
    logger?.warn("watch list not read; only the watched flag of companies applies", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** `jobs` row -> the fields the rules read. */
export function toFilterJob(row: FilterCandidate): FilterJob {
  return {
    title: row.title,
    description: row.description,
    companyName: row.companyName,
    companyNameNorm: row.companyNameNorm,
    companyAliases: row.companyAliases,
    companyBlacklisted: row.companyBlacklisted,
    companyWatched: row.companyWatched,
    locations: parseLocations(row.locationsJson),
    workplace: row.workplace,
    seniority: row.seniority,
    contract: row.contract,
    salary: parseSalary(row.salaryJson),
    germanLevel: asGermanLevel(row.germanLevel),
  };
}

/**
 * Evaluate one batch of jobs: the deal-breakers run over the whole batch first, each rule in its time box
 * (`dealBreakerVetoes`), then the rules job by job. `stored`: the job's filter reasons stored for this snapshot, so a rule that
 * is too slow to judge a job this time keeps the veto it gave before.
 */
export function evaluateBatch(
  rows: readonly FilterCandidate[],
  compiled: CompiledFilter,
  run: DealBreakerRun,
  overrides: ReadonlyMap<number, FilterOverride>,
  stored?: ReadonlyMap<number, { filterReasons: readonly string[] }>,
): FilterVerdict[] {
  const jobs = rows.map(toFilterJob);
  const previous = rows.map((row) => {
    const reasons = stored?.get(row.id)?.filterReasons;
    return reasons === undefined ? undefined : dealBreakerIds(reasons);
  });
  const { vetoes } = dealBreakerVetoes(run, jobs, { previous });
  return jobs.map((job, i) => evaluateJob(job, compiled, overrides.get(rows[i]?.id ?? 0) ?? null, vetoes[i] ?? []));
}

const sameReasons = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Evaluate eligible jobs against the preferences and store one result per (job,
 * profile snapshot) in `scores`. Idempotent: a second run with the same snapshot and the same jobs
 * skips unchanged inputs unless deal-breakers need to run under a time budget. Jobs that changed since
 * (a source delivered new details) get their result updated in place; when the preferences change
 * the snapshot changes, so every job gets a new row.
 */
export async function runFilter(db: Db, options: FilterOptions): Promise<FilterRunResult> {
  const watchedCompanies = options.watchedCompanies ?? currentWatchedCompanies(options.logger);
  // Version the evaluator along with all configuration it reads, including inputs outside the preference snapshot.
  const configHash = createHash("sha256").update(JSON.stringify([1, options.preferences, options.pipeline, options.me, watchedCompanies])).digest("hex");
  const compiled: CompiledFilter = compileFilter(options.preferences, options.pipeline, { me: options.me, watchedCompanies });
  const dealBreakers = startDealBreakerRun(compiled.dealBreakers, options.timeBox ?? vmTimeBox);
  // Phrase and visa rule health depends on this run's time budget, which an input fingerprint cannot predict.
  // Read unchanged jobs too so timeouts are reported and previous vetoes survive any incomplete evaluation.
  const skipUnchanged = compiled.dealBreakers.rules.every(({ rule }) => rule.type === "language_gate");
  const result: FilterRunResult = {
    snapshotId: options.snapshotId,
    evaluated: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    passed: 0,
    filteredOut: 0,
    byReason: {},
    aborted: false,
    dealBreakerWarnings: [],
  };

  let afterId = 0;
  for (;;) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const batch = await listFilterCandidates(db, { afterId, limit: options.pipeline.batch_size, jobIds: options.jobIds, snapshotId: options.snapshotId, configHash: skipUnchanged ? configHash : undefined });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id ?? afterId;

    const ids = batch.map((j) => j.id);
    const stored = await getFilterResults(db, options.snapshotId, ids);
    const overrides = new Map(batch.flatMap((row) => row.filterOverride ? [[row.id, row.filterOverride] as const] : []));
    const fresh: NewFilterResult[] = [];
    const verdicts = evaluateBatch(batch, compiled, dealBreakers, overrides, stored);
    // A timed-out rule preserves previous vetoes; retry those inputs next cycle instead of caching a partial judgement.
    const complete = !dealBreakers.warnings.some((warning) => warning.code === "too_slow");
    for (const [i, row] of batch.entries()) {
      const verdict = verdicts[i];
      if (!verdict) continue;
      result.evaluated += 1;
      if (verdict.result === "passed") result.passed += 1;
      else result.filteredOut += 1;
      for (const reason of verdict.reasons) {
        const code = reason.split(":", 1)[0] ?? reason;
        result.byReason[code] = (result.byReason[code] ?? 0) + 1;
      }

      const existing = stored.get(row.id);
      const state = { filterResult: verdict.result, filterReasons: verdict.reasons, filterInputHash: complete ? row.inputHash : null, filterConfigHash: complete ? configHash : null };
      if (!existing) {
        fresh.push({ jobId: row.id, ...state });
      } else {
        await updateFilterResult(db, existing.scoreId, state);
        if (existing.filterResult !== verdict.result || !sameReasons(existing.filterReasons, verdict.reasons)) result.updated += 1;
        else result.unchanged += 1;
      }
    }
    result.created += await insertFilterResults(db, options.snapshotId, fresh);
  }
  result.dealBreakerWarnings = [...compiled.dealBreakers.warnings, ...dealBreakers.warnings];
  for (const warning of result.dealBreakerWarnings) options.logger?.warn("deal-breaker not applied", { id: warning.id, reason: warning.code });
  options.logger?.info("hard filter done", { snapshotId: result.snapshotId, evaluated: result.evaluated, created: result.created, updated: result.updated, filteredOut: result.filteredOut });
  return result;
}

export interface CurrentPreferences {
  preferences: PreferencesConfig;
  snapshot: ProfileSnapshot;
  /** me.yaml as it is now (a language gate compares the user's level), or null when it cannot be read. Not part of the snapshot. */
  me: MeConfig | null;
}

/** me.yaml now, its template when missing, or null when unreadable/invalid (only the language gate needs it). */
export function currentMe(): MeConfig | null {
  try {
    return parseConfigText("me", readProfileText("me"));
  } catch {
    return null;
  }
}

/**
 * The preferences file as it is now and the snapshot of exactly that text. Saving through the UI
 * stored the snapshot already; a file edited by hand gets one here (and, like a UI save, marks the
 * scores of other snapshots stale).
 */
export async function currentPreferences(db: Db): Promise<CurrentPreferences> {
  const text = readProfileText("preferences");
  const preferences = parseConfigText("preferences", text);
  const snapshot = await snapshotForProfileText(db, "preferences", text);
  return { preferences, snapshot, me: currentMe() };
}

/**
 * Apply the user's decision about one job right away (the detail page's keep / exclude button): the
 * job's filter result under the current preferences is recomputed, so the page shows it without
 * waiting for the next cycle. Returns the new result, or null when the job is closed or unknown.
 */
export async function refilterJob(db: Db, jobId: number, logger?: ChannelLogger): Promise<{ filterResult: "passed" | "filtered_out"; filterReasons: string[] } | null> {
  const { preferences, snapshot, me } = await currentPreferences(db);
  const result = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), me, jobIds: [jobId], logger });
  if (result.evaluated === 0) return null;
  const stored = await getFilterResults(db, snapshot.id, [jobId]);
  const row = stored.get(jobId);
  return row ? { filterResult: row.filterResult, filterReasons: row.filterReasons } : null;
}

function requireDb(ctx: CycleStepContext): Db {
  if (!ctx.db) throw new Error("this cycle step needs a database");
  return ctx.db;
}

/** Cycle step `filter` (between `pipeline` and `signals`). */
export async function filterStep(ctx: CycleStepContext): Promise<StepResult> {
  const db = requireDb(ctx);
  const { preferences, snapshot, me } = await currentPreferences(db);
  const result = await runFilter(db, { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), me, logger: ctx.logger, signal: ctx.signal });
  // a deal-breaker too slow to judge every job is shown on the runs view (the jobs it did not reach keep their stored veto)
  const tooSlow = result.dealBreakerWarnings.some((warning) => warning.code === "too_slow");
  return { status: result.aborted || tooSlow ? "partial" : "ok", result };
}

/** Plug `filter` into the processing cycle (called once at start-up). */
export function registerFilterStep(): void {
  registerCycleStep("filter", filterStep);
}
