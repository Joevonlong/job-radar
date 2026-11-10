import { AiProviderError, AiUnavailableError } from "@/lib/ai";
import type { AiRouter } from "@/lib/ai/router";
import type { AiCallRecord } from "@/lib/ai/types";
import { safeErrorCode } from "@/lib/activity/error-codes";
import { ConfigError, loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { careerTailorPayloadSchema, type ControlHandler, type ControlHandlerContext } from "@/lib/control/types";
import { finishControlRequest, isControlRequestOpen } from "@/lib/db/repos/control-requests";
import { createRequestRouter } from "@/lib/translation/router";
import { classifyTranslationFailure } from "@/lib/translation/errors";
import { CareerStoreError } from "../contact/errors";
import { loadDocument } from "../store/documents";
import { loadTailorContext } from "./context";
import { writeProposals } from "./proposals";
import { CAREER_TAILOR_PROMPT_VERSION } from "./prompts";
import { runTailorSteps } from "./steps";

export interface CareerTailorHandlerOptions {
  createRouter?: (context: ControlHandlerContext) => AiRouter;
  loadSettings?: () => CareerConfig;
}

/** All private reads, parsing, scrubbing, provider calls, verification and publication stay inside this barrier. */
export function createCareerTailorHandler(options: CareerTailorHandlerOptions = {}): ControlHandler {
  return async (request, context) => {
    let timeout: AbortSignal | undefined;
    let lastCall: AiCallRecord | null = null;
    let settings: CareerConfig | undefined;
    try {
      if (!(await readCareerGate()).enabled) return failed("disabled");
      const parsed = careerTailorPayloadSchema.safeParse(request.payload);
      if (!parsed.success || parsed.data.mode === "shrink" && (parsed.data.over_pages === null || parsed.data.with_letter)) return failed("invalid_payload");
      settings = options.loadSettings?.() ?? loadConfig("career");
      if (!settings.enabled) return failed("disabled");
      const deadline = AbortSignal.timeout(Math.max(1, (request.startedAt?.getTime() ?? Date.now()) + settings.timeout_seconds * 1000 - Date.now()));
      timeout = deadline;
      const signal = AbortSignal.any([context.signal, deadline]);
      signal.throwIfAborted();
      const loaded = await loadTailorContext(context.db, parsed.data, settings);
      if (loaded.outbound.hash !== parsed.data.outbound_hash) return failed("outbound_changed");
      const router = options.createRouter?.(context) ?? createRequestRouter(context.db, context.logger);
      const generated = await runTailorSteps({ ...loaded, doc: loaded.document, router, payload: parsed.data, settings, signal, onCall: (call) => { lastCall = call; } });
      signal.throwIfAborted();
      const outcome = { status: "done" as const, result: { proposals: generated.items.length, dropped: generated.dropped, flagged: generated.items.filter((item) => item.claims.length > 0).length, model: generated.model, promptVersion: CAREER_TAILOR_PROMPT_VERSION } };
      try {
        const written = await writeProposals({ schema_version: 1, doc_id: loaded.document.id, doc_hash: loaded.baseHash, request_id: request.id, items: generated.items }, async () => {
          signal.throwIfAborted();
          if (!(await isControlRequestOpen(context.db, request.id))) return false;
          try { await loadDocument(loaded.document.id); }
          catch (error) {
            if (error instanceof CareerStoreError && error.code === "document_missing") throw new CareerStoreError("doc_gone");
            throw error;
          }
          return true;
        }, async () => {
          signal.throwIfAborted();
          return (await finishControlRequest(context.db, request.id, outcome)) !== null;
        });
        return written ? outcome : failed("deleted");
      } catch (error) {
        if (error instanceof CareerStoreError && error.code === "doc_gone") return failed("doc_gone");
        return failed(context.signal.aborted ? "aborted" : deadline.aborted ? "timeout" : "proposal_write_failed");
      }
    } catch (error) {
      let code = context.signal.aborted ? "aborted" : timeout?.aborted ? "timeout" : failureCode(error);
      const call = lastCall as AiCallRecord | null;
      if (code === "invalid_output" && settings && call) {
        try {
          const ai = loadConfig("ai");
          const limit = ai.tasks.career_tailor.max_output_tokens ?? ai.max_output_tokens;
          if (call.usage.tokensOut >= limit * settings.import.output_truncated_share) code = "output_truncated";
        } catch { code = "config_error"; }
      }
      context.logger.error("career tailoring failed", { error: safeErrorCode(code) });
      return failed(code);
    }
  };
}
function failed(error: string) { const code = safeErrorCode(error); return { status: "failed" as const, result: { error: code === "other" ? "handler_failed" : code } }; }
function failureCode(error: unknown): string {
  if (error instanceof CareerStoreError) return error.code;
  if (error instanceof ConfigError) return "config_error";
  if (error instanceof AiProviderError) return error.kind;
  if (error instanceof AiUnavailableError) return classifyTranslationFailure(error).code;
  return "handler_failed";
}
export const careerTailorHandler = createCareerTailorHandler();
