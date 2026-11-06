import { AiProviderError } from "@/lib/ai";
import { buildStoryExtractPrompt, STORY_EXTRACT_PROMPT_VERSION, storyExtractOutputSchema, type StoryExtractOutput } from "@/lib/ai/prompts/story-extract";
import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord, AiResult } from "@/lib/ai/types";
import { ConfigError, loadConfig, type WriterConfig } from "@/lib/config";
import { STORY_FILE_BOUNDS } from "@/lib/config/schemas/stories";
import { confirmedOutbound, NO_STORED_VALUES, OutboundMismatch, type OutboundText } from "@/lib/outbound/outbound";
import { neutralizeStorySource } from "@/lib/stories/source";
import { insertStoryDrafts } from "@/lib/db/repos/story-drafts";
import { countFlags } from "@/lib/stories/extract";
import { verifyExtractedDraft } from "@/lib/stories/verify-extract";
import { classifyTranslationFailure, resumeOf } from "@/lib/translation/errors";
import { createRequestRouter } from "@/lib/translation/router";

import { storyExtractPayloadSchema, type ControlHandler, type ControlHandlerContext } from "./types";

export interface StoryExtractHandlerOptions {
  /** Default: the router of ai.yaml (usage written to `ai_usage`). Tests inject a fake. */
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  /** Default: `loadConfig("writer")` (the worker hot-reloads it). */
  loadSettings?: () => WriterConfig;
}

/**
 * `story_extract`: extract story drafts from the source text in the payload into `profile_story_drafts`, each field checked
 * against that text here, while it is still at hand; `finishControlRequest` clears it from the payload right after. Claimed
 * only by the ai-worker. The result holds counts and machine codes only: a provider's error text can repeat what it was
 * sent, so it is left out (unlike the other AI requests). `stories.yaml` does not change until you adopt a draft.
 */
export function createStoryExtractHandler(options: StoryExtractHandlerOptions = {}): ControlHandler {
  const loadSettings = options.loadSettings ?? ((): WriterConfig => loadConfig("writer"));
  return async (request, context) => {
    const payload = storyExtractPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const { origin, sourceHash, text } = payload.data;
    const base = { origin };
    if (!payload.data.confirmed) return { status: "failed", result: { ...base, error: "preview_required" } };
    let outbound: OutboundText;
    try {
      outbound = confirmedOutbound(text, NO_STORED_VALUES);
      if (neutralizeStorySource(text) !== text) throw new OutboundMismatch();
    } catch (error) {
      if (error instanceof OutboundMismatch) return { status: "failed", result: { ...base, error: "scrub_mismatch" } };
      throw error;
    }
    let settings: WriterConfig;
    try {
      settings = loadSettings();
    } catch (error) {
      if (error instanceof ConfigError) return { status: "failed", result: { ...base, error: "config_error" } };
      throw error;
    }
    if (!settings.enabled) return { status: "failed", result: { ...base, error: "disabled" } };

    const prompt = buildStoryExtractPrompt({ text: outbound, maxDrafts: settings.import.max_drafts, quoteMaxChars: settings.evidence.quote_max_chars });
    const startedAt = request.startedAt?.getTime() ?? Date.now();
    const timeout = AbortSignal.timeout(Math.max(1, startedAt + settings.timeout_seconds * 1000 - Date.now()));
    let lastCall: AiCallRecord | null = null;
    let result: AiResult<StoryExtractOutput>;
    try {
      const router = options.createRouter ? options.createRouter(context) : createRequestRouter(context.db, context.logger);
      result = await router.run("story_extract", prompt, storyExtractOutputSchema, {
        signal: AbortSignal.any([context.signal, timeout]),
        onCall: (call) => {
          lastCall = call;
        },
      });
    } catch (error) {
      if (timeout.aborted && !context.signal.aborted) return { status: "failed", result: { ...base, error: "timeout" } };
      if (error instanceof AiProviderError && error.kind === "aborted") return { status: "failed", result: { ...base, error: "aborted" } };
      const failure = classifyTranslationFailure(error);
      const call = lastCall as AiCallRecord | null;
      const ai = loadConfig("ai");
      const cap = ai.tasks.story_extract.max_output_tokens ?? ai.max_output_tokens;
      if (failure.code === "invalid_output" && call !== null && call.usage.tokensOut >= cap * settings.output_truncated_share) {
        return { status: "failed", result: { ...base, error: "output_truncated" } };
      }
      return { status: "failed", result: { ...base, error: failure.code, ...resumeOf(failure) } };
    }

    const limits = { titleMaxChars: settings.stories.title_max_chars, textMaxChars: settings.stories.text_max_chars, listMaxItems: STORY_FILE_BOUNDS.listItems };
    const drafts = result.value.drafts.slice(0, settings.import.max_drafts).map((draft) => verifyExtractedDraft(text, draft, settings.evidence, limits));
    try {
      await insertStoryDrafts(context.db, { origin, sourceHash, drafts });
    } catch (error) {
      context.logger.error("story drafts could not be stored", { error: error instanceof Error ? error.name : "unknown" });
      return { status: "failed", result: { ...base, error: "handler_error" } };
    }
    return {
      status: "done",
      result: {
        ...base,
        drafts: drafts.length,
        flagged: drafts.filter((draft) => countFlags(draft) > 0).length,
        provider: result.provider,
        model: result.model ?? null,
        promptVersion: STORY_EXTRACT_PROMPT_VERSION,
      },
    };
  };
}

export const storyExtractHandler: ControlHandler = createStoryExtractHandler();
