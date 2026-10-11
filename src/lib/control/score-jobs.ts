import { QUOTA_GUARD_CODE } from "@/lib/ai/errors";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { createScoringDeps, PROFILE_INCOMPLETE, scoreBacklog, scoreJobs, type ScoringDeps, type ScoringResult } from "@/lib/scoring";

import { requestTranslateJob } from "./translate-request";
import { scoreJobsPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface ScoreJobsHandlerOptions {
  /** How the scoring dependencies are built (default: the real router from ai.yaml; tests inject a fake provider). */
  createDeps?: (context: ControlHandlerContext) => ScoringDeps;
}

function summarize(result: ScoringResult, translationsQueued: number) {
  return {
    scored: result.scored,
    translationsQueued,
    failed: result.failed,
    skipped: result.skipped,
    // what is still waiting for a first score after this run
    remaining: result.backlog.unscored,
    placeholder: false,
  };
}

/**
 * What a cycle does after its scores, done for the jobs this request scored: a job whose rank value
 * reaches ai.yaml `translate_auto_min_score` gets a `translate_job` request (the cycle would only translate it
 * next time). The push needs nothing here: a job scored within `candidate_window_hours` is a push candidate of
 * the next cycle (`listPushCandidates`). Returns how many translations were queued; an existing translation or
 * an open request for the job is reused, never doubled.
 */
async function followUpScores(db: Db, result: ScoringResult, minRank: number): Promise<number> {
  let queued = 0;
  for (const { jobId, rankValue } of result.scoredJobs) {
    if (rankValue === null || rankValue < minRank) continue;
    const outcome = await requestTranslateJob(db, { jobId, force: false });
    if (outcome.state === "queued" && !outcome.existing) queued += 1;
  }
  return queued;
}

/**
 * `score_jobs`: score the given jobs (`{ jobIds }`) or the waiting backlog (`{ backlog: true }`, up to
 * ai.yaml `scoring.backlog_per_run`) now, most relevant first. Like `rescore_stale` it is registered by
 * the runner only (it talks to the real AI providers), through `registerControlHandler`, so the host
 * AI worker can take it over without changes here.
 */
export function createScoreJobsHandler(options: ScoreJobsHandlerOptions = {}): ControlHandler {
  return async (request, context) => {
    const payload = scoreJobsPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const deps = options.createDeps
      ? options.createDeps(context)
      : createScoringDeps({ db: context.db, logger: context.logger, timeZone: loadConfig("schedule").timezone, signal: context.signal });
    const result = "jobIds" in payload.data ? await scoreJobs(deps, payload.data.jobIds) : await scoreBacklog(deps);
    const summary = summarize(result, await followUpScores(context.db, result, deps.config.translate_auto_min_score));
    // Nothing could be scored: say why. No AI provider could be used (then every tried posting failed too),
    // some postings failed, the profile is incomplete (which fields), or the run was cancelled.
    if (result.scored === 0 && result.stopped === "ai_unavailable") return { status: "failed", result: { ...summary, error: "score_ai_unavailable" } };
    // Job Radar's AI usage cap (window, or a limit the provider reported) holds the AI back: say until when
    if (result.scored === 0 && result.stopped === QUOTA_GUARD_CODE) return { status: "failed", result: { ...summary, error: QUOTA_GUARD_CODE, resumeAt: result.quotaResumeAt ?? null } };
    if (result.scored === 0 && result.failed > 0) return { status: "failed", result: { ...summary, error: "score_failed" } };
    if (result.stopped === PROFILE_INCOMPLETE) return { status: "failed", result: { ...summary, error: "score_profile_incomplete", profileMissing: result.profileMissing ?? [] } };
    if (result.scored === 0 && result.stopped !== undefined) return { status: "failed", result: { ...summary, error: "score_stopped" } };
    return { status: "done", result: summary };
  };
}

export const scoreJobsHandler: ControlHandler = createScoreJobsHandler();
