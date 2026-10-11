import { QUOTA_GUARD_CODE } from "@/lib/ai/errors";
import { loadConfig } from "@/lib/config";
import { createScoringDeps, PROFILE_INCOMPLETE, rescoreStale, type ScoringDeps } from "@/lib/scoring";

import type { ControlHandler, ControlHandlerContext } from "./types";

export interface RescoreHandlerOptions {
  /** How the scoring dependencies are built (default: the real router from ai.yaml; tests inject a fake provider). */
  createDeps?: (context: ControlHandlerContext) => ScoringDeps;
}

/**
 * `rescore_stale`: re-score the postings whose score went stale (profile or prompt changed), up to the
 * cycle limit of ai.yaml, with `rescoreStale`. Registered by the runner only: it talks to the
 * real AI providers, so nothing else (tests, the web app) gets it by default.
 */
export function createRescoreStaleHandler(options: RescoreHandlerOptions = {}): ControlHandler {
  return async (_request, context) => {
    const deps = options.createDeps
      ? options.createDeps(context)
      : createScoringDeps({ db: context.db, logger: context.logger, timeZone: loadConfig("schedule").timezone, signal: context.signal });
    const result = await rescoreStale(deps);
    const summary = { scored: result.scored, failed: result.failed, remaining: result.backlog.stale, placeholder: false };
    // Nothing could be scored: say why. No AI provider could be used (then every tried posting failed too),
    // some postings failed, the profile is incomplete (which fields), or the run was cancelled.
    if (result.scored === 0 && result.stopped === "ai_unavailable") return { status: "failed", result: { ...summary, error: "rescore_ai_unavailable" } };
    // Job Radar's AI usage cap (window, or a limit the provider reported) holds the AI back: say until when
    if (result.scored === 0 && result.stopped === QUOTA_GUARD_CODE) return { status: "failed", result: { ...summary, error: QUOTA_GUARD_CODE, resumeAt: result.quotaResumeAt ?? null } };
    if (result.scored === 0 && result.failed > 0) return { status: "failed", result: { ...summary, error: "rescore_failed" } };
    if (result.stopped === PROFILE_INCOMPLETE) return { status: "failed", result: { ...summary, error: "rescore_profile_incomplete", profileMissing: result.profileMissing ?? [] } };
    if (result.scored === 0 && result.stopped !== undefined) return { status: "failed", result: { ...summary, error: "rescore_stopped" } };
    return { status: "done", result: summary };
  };
}

export const rescoreStaleHandler: ControlHandler = createRescoreStaleHandler();
