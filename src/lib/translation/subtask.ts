import { AiProviderError, AiUnavailableError, registerAiSubtask, type AiSubtask, type AiSubtaskContext } from "@/lib/ai";
import { listTranslationCandidates, type TranslationCandidate } from "@/lib/db/repos/translations";
import type { Db } from "@/lib/db/client";

import { TranslationIncompleteError } from "./errors";
import { ensureTranslation, type EnsureTranslationResult } from "./service";
import { translationTarget } from "@/lib/i18n/config";

export const TRANSLATE_SUBTASK_NAME = "translate";

export interface TranslateSubtaskResult {
  /** Why nothing ran (dry run, no database). */
  skipped?: string;
  minRank: number;
  candidates: number;
  translated: number;
  failed: number;
  /** The AI had no provider left: the remaining candidates were not tried. */
  aiUnavailable: boolean;
  /** Job ids that failed this cycle with a short reason. */
  failures: Array<{ jobId: number; reason: string }>;
}

/** The two things the sub-task does with the database / the AI; replaceable in tests. */
export interface TranslateSubtaskDeps {
  listCandidates(db: Db, args: { lang: string; minRank: number; limit: number }): Promise<TranslationCandidate[]>;
  translate(ctx: AiSubtaskContext, db: Db, jobId: number, target: string): Promise<EnsureTranslationResult>;
  /** The language to translate into (default: `language.yaml: translation.target`). */
  target?: () => string;
}

const defaultDeps: TranslateSubtaskDeps = {
  listCandidates: listTranslationCandidates,
  translate: (ctx, db, jobId, target) => ensureTranslation(db, ctx.router, jobId, { signal: ctx.cycle.signal, logger: ctx.cycle.logger, now: ctx.cycle.now, settings: ctx.config.translation, target }),
};

/**
 * The `translate` AI sub-task: jobs whose rank value reaches
 * `translate_auto_min_score` and that have no current translation into the target language (and are not written in it) are translated, best rank
 * first, at most `per_cycle_limit` per cycle. A job that fails does not stop the others; running out
 * of reachable providers does.
 */
export async function runTranslateSubtask(ctx: AiSubtaskContext, deps: TranslateSubtaskDeps = defaultDeps): Promise<TranslateSubtaskResult> {
  const minRank = ctx.config.translate_auto_min_score;
  const result: TranslateSubtaskResult = { minRank, candidates: 0, translated: 0, failed: 0, aiUnavailable: false, failures: [] };
  const db = ctx.cycle.db;
  if (ctx.cycle.dryRun || db === null) return { ...result, skipped: ctx.cycle.dryRun ? "dry run" : "no database" };

  const target = (deps.target ?? translationTarget)();
  const candidates = await deps.listCandidates(db, { lang: target, minRank, limit: ctx.perCycleLimit });
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    if (ctx.cycle.signal.aborted) break;
    try {
      const outcome = await deps.translate(ctx, db, candidate.jobId, target);
      if (outcome.status === "translated") result.translated += 1;
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") break;
      result.failed += 1;
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error";
      result.failures.push({ jobId: candidate.jobId, reason });
      ctx.cycle.logger.warn("translation failed", { jobId: candidate.jobId, error: reason });
      // Providers that were unreachable (or out of budget) will not answer the next job either; a job that
      // only produced unusable output is just skipped over.
      const providerDown = error instanceof TranslationIncompleteError ? error.failure.providerWide : error instanceof AiUnavailableError && !error.attempts.some((a) => a.kind === "invalid_output");
      if (providerDown) {
        result.aiUnavailable = true;
        break;
      }
    }
  }
  return result;
}

export const translateSubtask: AiSubtask = { name: TRANSLATE_SUBTASK_NAME, late: true, run: (ctx) => runTranslateSubtask(ctx) };

export function registerTranslationSubtask(): void {
  registerAiSubtask(translateSubtask);
}
