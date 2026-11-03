import { AiProviderError } from "@/lib/ai";
import { buildFitPrompt, FIT_PROMPT_VERSION, fitOutputSchema } from "@/lib/ai/prompts/write";
import type { AiRouter } from "@/lib/ai/router";
import { ConfigError, loadConfig, type TrapsConfig, type WriterConfig } from "@/lib/config";
import { replaceFitNote } from "@/lib/db/repos/application-fit-notes";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";
import { checkFitItems } from "@/lib/writer/fit";
import { companyBackgroundEntries } from "@/lib/writer/materials";

import { writerFitPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface WriterFitHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  loadSettings?: () => WriterConfig;
  loadTraps?: () => TrapsConfig;
}

/**
 * `writer_fit`: where the ticked company background meets the chosen stories. The same `write` task as the answers, so it has no web
 * search of its own; both sources come from the payload, and every item is checked before it is stored (`checkFitItems`). The result
 * never holds text of the material; the payload's material is cleared when the request ends.
 */
export function createWriterFitHandler(options: WriterFitHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): WriterConfig => loadConfig("writer"));
  const loadTraps = options.loadTraps ?? ((): TrapsConfig => loadConfig("traps"));
  return async (request, context) => {
    const payload = writerFitPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { jobId, questionId, materials, materialsHash, refs } = payload.data;
    const base = { jobId, questionId };
    let settings: WriterConfig;
    try {
      settings = loadSettings();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { ...base, error: "config_error" } };
      throw error;
    }
    if (!settings.enabled) return { status: "failed", result: { ...base, error: "disabled" } };
    let traps: TrapsConfig | null = null;
    try {
      traps = loadTraps();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
    }

    const prompt = buildFitPrompt({
      company: companyBackgroundEntries(materials.company),
      input: { job: materials.job, stories: materials.stories },
      outputLanguage: materials.outputLanguage,
      maxItems: settings.fit.max_items,
      quoteMaxChars: settings.evidence.quote_max_chars,
    });
    const startedAt = request.startedAt?.getTime() ?? Date.now();
    const timeout = AbortSignal.timeout(Math.max(1, startedAt + settings.timeout_seconds * 1000 - Date.now()));
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      const result = await router.run("write", prompt, fitOutputSchema, { signal: AbortSignal.any([context.signal, timeout]), jobId });
      const items = checkFitItems(
        result.value.items,
        { company: materials.company, stories: materials.stories, companyName: materials.job.company, language: materials.outputLanguage, evidence: settings.evidence, traps },
        settings.fit.max_items,
      );
      await replaceFitNote(context.db, {
        jobId,
        companyResearchId: refs.companyResearchId,
        materialsHash,
        storyIds: refs.storyIds,
        items,
        provider: result.provider,
        model: result.model,
        promptVersion: FIT_PROMPT_VERSION,
        controlRequestId: request.id,
      });
      return { status: "done", result: { ...base, items: items.length, flagged: items.filter((item) => item.status === "flagged").length, provider: result.provider, model: result.model } };
    } catch (error) {
      if (timeout.aborted && !context.signal.aborted) return { status: "failed", result: { ...base, error: "timeout" } };
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { ...base, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      return { status: "failed", result: { ...base, error: failure.code, detail: failure.message, ...resumeOf(failure) } };
    }
  };
}

export const writerFitHandler = createWriterFitHandler();
