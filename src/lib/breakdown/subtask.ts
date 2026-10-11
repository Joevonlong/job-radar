import { AiProviderError, AiUnavailableError, registerAiSubtask, type AiSubtask, type AiSubtaskContext } from "@/lib/ai";
import { ConfigError, loadConfig, type BreakdownConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { listBreakdownCandidates } from "@/lib/db/repos/breakdowns";

import { runBreakdown, type BreakdownRunOutcome } from "./service";

export const BREAKDOWN_SUBTASK_NAME = "breakdown";

export interface BreakdownSubtaskResult {
  /** Why nothing ran: off, manual mode, unreadable breakdown.yaml, dry run, no database. */
  skipped?: "disabled" | "manual" | "config_error" | "dry run" | "no database";
  minRank: number | null;
  candidates: number;
  done: number;
  failed: number;
  aiUnavailable: boolean;
  failures: Array<{ jobId: number; reason: string }>;
}

export interface BreakdownSubtaskDeps {
  loadSettings(): BreakdownConfig;
  listCandidates(db: Db, args: { minRank: number; limit: number }): Promise<Array<{ jobId: number }>>;
  run(ctx: AiSubtaskContext, db: Db, jobId: number, settings: BreakdownConfig): Promise<BreakdownRunOutcome>;
}

const defaultDeps: BreakdownSubtaskDeps = {
  loadSettings: () => loadConfig("breakdown"),
  listCandidates: listBreakdownCandidates,
  run: (ctx, db, jobId, settings) => runBreakdown(db, ctx.router, jobId, { force: false, settings, signal: ctx.cycle.signal, logger: ctx.cycle.logger }),
};

/**
 * The `breakdown` AI sub-task (`mode: auto` only): after the translation, jobs whose rank value reaches
 * `auto.min_rank` and that have no current breakdown are broken down, best rank first, at most `auto.per_cycle_limit`
 * per cycle. Off / manual / unreadable config return an ordinary result with `skipped` (NOT `skipSubtask`: that would
 * mark the AI step partial, and this is a normal setting).
 */
export async function runBreakdownSubtask(ctx: AiSubtaskContext, deps: BreakdownSubtaskDeps = defaultDeps): Promise<BreakdownSubtaskResult> {
  const result: BreakdownSubtaskResult = { minRank: null, candidates: 0, done: 0, failed: 0, aiUnavailable: false, failures: [] };
  let settings: BreakdownConfig;
  try {
    settings = deps.loadSettings();
  } catch (error) {
    if (error instanceof ConfigError) return { ...result, skipped: "config_error" };
    throw error;
  }
  if (!settings.enabled) return { ...result, skipped: "disabled" };
  if (settings.mode !== "auto") return { ...result, skipped: "manual" };
  const db = ctx.cycle.db;
  if (ctx.cycle.dryRun || db === null) return { ...result, minRank: settings.auto.min_rank, skipped: ctx.cycle.dryRun ? "dry run" : "no database" };

  result.minRank = settings.auto.min_rank;
  const candidates = await deps.listCandidates(db, { minRank: settings.auto.min_rank, limit: settings.auto.per_cycle_limit });
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    if (ctx.cycle.signal.aborted) break;
    try {
      const outcome = await deps.run(ctx, db, candidate.jobId, settings);
      if (outcome.status === "done") result.done += 1;
      else {
        result.failed += 1;
        result.failures.push({ jobId: candidate.jobId, reason: outcome.error });
      }
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") break;
      result.failed += 1;
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error";
      result.failures.push({ jobId: candidate.jobId, reason });
      ctx.cycle.logger.warn("breakdown failed", { jobId: candidate.jobId, error: reason });
      // Providers that were unreachable will not answer the next job either; unusable output only skips this job.
      if (error instanceof AiUnavailableError && !error.attempts.some((a) => a.kind === "invalid_output")) {
        result.aiUnavailable = true;
        break;
      }
    }
  }
  return result;
}

export const breakdownSubtask: AiSubtask = { name: BREAKDOWN_SUBTASK_NAME, late: true, run: (ctx) => runBreakdownSubtask(ctx) };

export function registerBreakdownSubtask(): void {
  registerAiSubtask(breakdownSubtask);
}
