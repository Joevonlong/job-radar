import { QUOTA_GUARD_CODE, quotaGuardResume, sanitize } from "@/lib/ai/errors";
import { loadConfig } from "@/lib/config";
import { createSuggestDeps, runSuggest, type SuggestDeps } from "@/lib/interests/suggest";

import { registerControlHandler } from "./handlers";
import type { ControlHandler, ControlHandlerContext } from "./types";

export interface RunSuggestHandlerOptions {
  /** How the dependencies are built (default: the real router from ai.yaml; tests inject a fake provider). */
  createDeps?: (context: ControlHandlerContext) => SuggestDeps;
}

/**
 * `run_suggest`: one pass of the weekly interests suggestions. The runner's scheduler leaves the request
 * on `suggest.cron` of schedule.yaml; /settings and tests may leave one too. Registered where the AI runs (see
 * `registerBuiltinAiSubtasks`): it talks to the real AI providers, so nothing else gets it by default.
 */
export function createRunSuggestHandler(options: RunSuggestHandlerOptions = {}): ControlHandler {
  return async (_request, context) => {
    try {
      const deps = options.createDeps
        ? options.createDeps(context)
        : createSuggestDeps({ db: context.db, logger: context.logger, timeZone: loadConfig("schedule").timezone, signal: context.signal });
      const summary = await runSuggest(deps);
      return { status: "done", result: { ...summary } };
    } catch (error) {
      const capped = quotaGuardResume(error);
      if (capped) {
        context.logger.warn("run_suggest held back by Job Radar's AI usage cap", { resumeAt: capped.resumeAt });
        return { status: "failed", result: { error: QUOTA_GUARD_CODE, resumeAt: capped.resumeAt } };
      }
      const detail = error instanceof Error ? sanitize(`${error.name}: ${error.message}`).slice(0, 300) : "unknown error";
      context.logger.error("run_suggest failed", { detail });
      return { status: "failed", result: { error: "suggest_failed", detail } };
    }
  };
}

export const runSuggestHandler: ControlHandler = createRunSuggestHandler();

/** Plug the real `run_suggest` handler into the control poller of this process. */
export function registerSuggestHandler(): void {
  registerControlHandler("run_suggest", runSuggestHandler);
}
