import { AiProviderError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { runBreakdown } from "@/lib/breakdown/service";
import { ConfigError, loadConfig, type BreakdownConfig } from "@/lib/config";
import { classifyTranslationFailure } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";

import { breakdownJobPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface BreakdownJobHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Default: `loadConfig("breakdown")` (the worker hot-reloads it). */
  loadSettings?: () => BreakdownConfig;
}

/**
 * `breakdown_job`: break one job's JD down (the button on the job page) with `runBreakdown`, which writes
 * `job_breakdowns`. Claimed only by the ai-worker. The page polls the request; error codes are the ones the
 * breakdown card has labels for (`BREAKDOWN_ERROR_CODES`).
 */
export function createBreakdownJobHandler(options: BreakdownJobHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): BreakdownConfig => loadConfig("breakdown"));
  return async (request, context) => {
    const payload = breakdownJobPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, force } = payload.data;
    let settings: BreakdownConfig;
    try {
      settings = loadSettings();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { jobId, error: "config_error" } };
      throw error;
    }
    if (!settings.enabled) return { status: "failed", result: { jobId, error: "disabled" } };
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      const outcome = await runBreakdown(context.db, router, jobId, { force, settings, signal: context.signal, logger: context.logger });
      if (outcome.status === "failed") return { status: "failed", result: { jobId, error: outcome.error } };
      return { status: "done", result: { jobId, cached: outcome.cached, provider: outcome.provider, model: outcome.model, items: outcome.items, dropped: outcome.dropped } };
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { jobId, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      return { status: "failed", result: { jobId, error: failure.code, detail: failure.message } };
    }
  };
}

export const breakdownJobHandler: ControlHandler = createBreakdownJobHandler();
