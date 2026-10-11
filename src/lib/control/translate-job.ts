import { AiProviderError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import { classifyTranslationFailure, TranslationIncompleteError } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";
import { ensureTranslation, type TranslationSettings } from "@/lib/translation/service";

import { translateJobPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface TranslateJobHandlerOptions {
  /** How the AI router is built (default: the one from ai.yaml; tests inject a fake provider). */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Piece size and timeout (default: `ai.yaml: translation`). */
  settings?: TranslationSettings;
}

/**
 * `translate_job`: translate one job's JD into the configured target language (the button on the job page) with `ensureTranslation`, which
 * writes `translations`. A long JD is translated piece by piece and a failed attempt keeps its finished pieces, so
 * a retry (a new request) only does the rest. The page polls the request; the error codes are the ones the
 * translation tab has labels for (`TranslationFailureCode`).
 */
export function createTranslateJobHandler(options: TranslateJobHandlerOptions = {}): ControlHandler {
  return async (request, context) => {
    const payload = translateJobPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, force } = payload.data;
    const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
    try {
      const outcome = await ensureTranslation(context.db, router, jobId, { force, signal: context.signal, logger: context.logger, ...(options.settings ? { settings: options.settings } : {}) });
      if (!("translation" in outcome)) return { status: "failed", result: { jobId, error: outcome.status } };
      return { status: "done", result: { jobId, translation: outcome.status, provider: outcome.translation.provider } };
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { jobId, error: "aborted" } };
      // The pieces that were translated stay saved (`translation_progress`); the result names the real cause and how far it got.
      if (error instanceof TranslationIncompleteError) return { status: "failed", result: { jobId, error: error.failure.code, detail: error.failure.message, done: error.done, total: error.total } };
      const failure = classifyTranslationFailure(error);
      return { status: "failed", result: { jobId, error: failure.code, detail: failure.message } };
    }
  };
}

export const translateJobHandler: ControlHandler = createTranslateJobHandler();
