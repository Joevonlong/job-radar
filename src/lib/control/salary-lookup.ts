import { AiProviderError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { ConfigError, loadConfig, type SalaryConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { FxTable } from "@/lib/market/currency";
import { runSalaryLookup } from "@/lib/salary/lookup";
import { loadBaseCurrency } from "@/lib/signals/floor";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";

import { salaryLookupPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface SalaryLookupHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Default: `loadConfig("salary")` (the worker hot-reloads it). */
  loadSettings?: () => SalaryConfig;
  /** Default: the market's base currency and pipeline.yaml's rates. */
  loadMoney?: () => { currency: string | null; fx: FxTable };
}

/**
 * `salary_lookup`: one on-demand salary lookup with web search (`runSalaryLookup`), claimed only by the ai-worker.
 * The switch is checked again here: a request queued before the user turned the lookup off is not run.
 */
export function createSalaryLookupHandler(options: SalaryLookupHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): SalaryConfig => loadConfig("salary"));
  const loadMoney =
    options.loadMoney ??
    ((): { currency: string | null; fx: FxTable } => {
      const salary = loadPipeline().salary;
      return { currency: loadBaseCurrency(), fx: { fx_pivot: salary.fx_pivot, fx_rates: salary.fx_rates } };
    });
  return async (request, context) => {
    const payload = salaryLookupPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, force } = payload.data;
    let settings: SalaryConfig;
    let money: { currency: string | null; fx: FxTable };
    try {
      settings = loadSettings();
      money = loadMoney();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { jobId, error: "config_error" } };
      throw error;
    }
    if (!settings.lookup.enabled) return { status: "failed", result: { jobId, error: "disabled" } };
    if (money.currency === null) return { status: "failed", result: { jobId, error: "config_error" } };
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      const outcome = await runSalaryLookup(context.db, router, jobId, { force, config: settings, currency: money.currency, fx: money.fx, signal: context.signal, logger: context.logger });
      if (outcome.status === "failed") return { status: "failed", result: { jobId, error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) } };
      return { status: "done", result: { jobId, ...outcome } };
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { jobId, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      return { status: "failed", result: { jobId, error: failure.code, detail: failure.message, ...resumeOf(failure) } };
    }
  };
}

export const salaryLookupHandler: ControlHandler = createSalaryLookupHandler();
