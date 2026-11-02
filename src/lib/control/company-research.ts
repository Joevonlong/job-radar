import { AiProviderError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { ConfigError, loadConfig, reloadConfig, type ResearchConfig } from "@/lib/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { runCompanyResearch } from "@/lib/research/company";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";

import { companyResearchPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface CompanyResearchHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Default: research.yaml, read afresh, so that turning the feature off stops what is still queued. */
  loadSettings?: () => ResearchConfig;
  /** Default: traps.yaml. Without its patterns no answer is stored (the request fails as `config_error`). */
  loadTraps?: () => TrapsConfig;
}

/**
 * `company_research`: one company background with web search (`runCompanyResearch`), claimed only by the ai-worker. The
 * switch is checked again here: a request queued before the user turned the feature off is not run.
 */
export function createCompanyResearchHandler(options: CompanyResearchHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): ResearchConfig => reloadConfig("research"));
  const loadTraps = options.loadTraps ?? ((): TrapsConfig => loadConfig("traps"));
  return async (request, context) => {
    const payload = companyResearchPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, force, origin } = payload.data;
    let settings: ResearchConfig;
    let traps: TrapsConfig;
    try {
      settings = loadSettings();
      traps = loadTraps();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { jobId, error: "config_error" } };
      throw error;
    }
    if (!settings.enabled) return { status: "failed", result: { jobId, error: origin === "auto" ? "research_disabled" : "disabled" } };
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      const outcome = await runCompanyResearch(context.db, router, jobId, { force, config: settings, traps, signal: context.signal, logger: context.logger });
      if (outcome.status === "failed") return { status: "failed", result: { jobId, error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) } };
      return { status: "done", result: { jobId, ...outcome } };
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { jobId, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      return { status: "failed", result: { jobId, error: failure.code, detail: failure.message, ...resumeOf(failure) } };
    }
  };
}

export const companyResearchHandler: ControlHandler = createCompanyResearchHandler();
