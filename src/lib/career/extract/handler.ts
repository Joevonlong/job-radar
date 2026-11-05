import { AiProviderError, AiUnavailableError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord } from "@/lib/ai/types";
import { ConfigError, loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { careerExtractPayloadSchema, type ControlHandler, type ControlHandlerContext } from "@/lib/control/types";
import { isControlRequestOpen } from "@/lib/db/repos/control-requests";
import { createRequestRouter } from "@/lib/translation/router";
import { classifyTranslationFailure } from "@/lib/translation/errors";
import { confirmedOutbound } from "../ai/outbound";
import { CareerStoreError } from "../contact/errors";
import { loadCareerProfile } from "../store/profile";
import { writeCareerDraft } from "./draft-store";
import { suggestCareerMatches } from "./match";
import { buildCareerExtractPrompt, careerExtractOutputSchema, CAREER_EXTRACT_PROMPT_VERSION } from "./prompt";
import { draftFields, DRAFT_SECTIONS, verifyCareerExtract } from "./verify";

export interface CareerExtractHandlerOptions {
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  loadSettings?: () => CareerConfig;
}

/** The exception barrier covers all private input handling, including configuration, verification and filesystem writes. */
export function createCareerExtractHandler(options: CareerExtractHandlerOptions = {}): ControlHandler {
  return async (request, context) => {
    let timeout: AbortSignal | undefined;
    let lastCall: AiCallRecord | null = null;
    let settings: CareerConfig | undefined;
    try {
      if (!(await readCareerGate()).enabled) return { status: "failed", result: { error: "disabled" } };
      const payload = careerExtractPayloadSchema.safeParse(request.payload);
      if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
      settings = options.loadSettings?.() ?? loadConfig("career");
      if (!settings.enabled) return { status: "failed", result: { error: "disabled" } };
      const text = confirmedOutbound(payload.data.text);
      const prompt = buildCareerExtractPrompt({ text, quoteMaxChars: settings.evidence.quote_max_chars });
      timeout = AbortSignal.timeout(Math.max(1, (request.startedAt?.getTime() ?? Date.now()) + settings.timeout_seconds * 1000 - Date.now()));
      context.signal.throwIfAborted();
      const router = options.createRouter?.(context) ?? createRequestRouter(context.db, context.logger);
      const ai = await router.run("career_extract", prompt, careerExtractOutputSchema, {
        signal: AbortSignal.any([context.signal, timeout]), onCall: (call) => { lastCall = call; },
      });
      context.signal.throwIfAborted();
      timeout.throwIfAborted();
      const sections = suggestCareerMatches((await loadCareerProfile()).profile, verifyCareerExtract(text, ai.value, settings.evidence));
      let written: boolean;
      try {
        written = await writeCareerDraft({
          schema_version: 1, request_id: request.id, origin: payload.data.origin, source_hash: payload.data.sourceHash,
          created_at: new Date().toISOString(), language: ai.value.language, sections,
        }, async () => {
          context.signal.throwIfAborted();
          timeout!.throwIfAborted();
          return isControlRequestOpen(context.db, request.id);
        });
      } catch (error) {
        context.logger.error("career extraction failed", { error: safeName(error) });
        return { status: "failed", result: { error: context.signal.aborted ? "aborted" : timeout.aborted ? "timeout" : "draft_write_failed" } };
      }
      if (!written) return { status: "failed", result: { error: "deleted" } };
      return { status: "done", result: { entries: DRAFT_SECTIONS.reduce((count, section) => count + sections[section].length, 0), flagged: draftFields(sections).filter((field) => field.flags.length).length, model: ai.model ?? null, promptVersion: CAREER_EXTRACT_PROMPT_VERSION } };
    } catch (error) {
      context.logger.error("career extraction failed", { error: safeName(error) });
      let code = error instanceof CareerStoreError ? error.code : error instanceof ConfigError ? "config_error" : error instanceof AiProviderError ? error.kind : error instanceof AiUnavailableError ? classifyTranslationFailure(error).code : "handler_failed";
      if (context.signal.aborted) code = "aborted";
      if (timeout?.aborted && !context.signal.aborted) code = "timeout";
      const call = lastCall as AiCallRecord | null;
      if (code === "invalid_output" && settings && call) {
        try {
          const ai = loadConfig("ai");
          if (call.usage.tokensOut >= (ai.tasks.career_extract.max_output_tokens ?? ai.max_output_tokens) * settings.import.output_truncated_share) code = "output_truncated";
        } catch { code = "config_error"; }
      }
      return { status: "failed", result: { error: code } };
    }
  };
}

function safeName(error: unknown): string {
  try { return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name) ? error.name : "Error"; }
  catch { return "Error"; }
}
export const careerExtractHandler: ControlHandler = createCareerExtractHandler();
