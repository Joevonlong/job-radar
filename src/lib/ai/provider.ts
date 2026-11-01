import { z, type ZodType } from "zod";

import { AiProviderError } from "./errors";
import { toJsonSchema } from "./schema-to-json";
import type {
  AiPrompt,
  AiProvider,
  AiProviderKind,
  AiProviderResult,
  AiRunOptions,
  AiTask,
  AiTokenUsage,
  AiTransport,
  AiTransportRequest,
} from "./types";
import { AI_PROVIDER_KIND } from "./types";

const MAX_ECHOED_REPLY = 1_500;
const MAX_ISSUES_TEXT = 1_200;

/** Pull a JSON value out of a model reply: plain JSON, a fenced block, or JSON surrounded by prose. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  throw new SyntaxError("reply is not valid JSON");
}

function validate<T>(schema: ZodType<T>, text: string): { ok: true; value: T } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch {
    return { ok: false, problem: "the reply was not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, problem: z.prettifyError(parsed.error).slice(0, MAX_ISSUES_TEXT) };
}

function retryPrompt(prompt: AiPrompt, previousReply: string, problem: string): AiPrompt {
  const echoed = previousReply.length > MAX_ECHOED_REPLY ? `${previousReply.slice(0, MAX_ECHOED_REPLY)}…` : previousReply;
  return {
    system: prompt.system,
    user: `${prompt.user}\n\n---\nYour previous reply was rejected by validation.\nPrevious reply:\n${echoed}\nProblems:\n${problem}\n\nReply again with ONLY a JSON object that matches the required schema: no prose, no code fences.`,
  };
}

/** Sum `usage` into `total`; a sub-count is summed over the calls that reported it, `reported` turns false when any call lacked usage. */
function addUsage(total: AiTokenUsage, usage: AiTokenUsage): void {
  total.tokensIn += usage.tokensIn;
  total.tokensOut += usage.tokensOut;
  if (usage.cachedIn !== undefined) total.cachedIn = (total.cachedIn ?? 0) + usage.cachedIn;
  if (usage.cacheWriteIn !== undefined) total.cacheWriteIn = (total.cacheWriteIn ?? 0) + usage.cacheWriteIn;
  if (usage.reasoningOut !== undefined) total.reasoningOut = (total.reasoningOut ?? 0) + usage.reasoningOut;
  if (usage.reported === false) total.reported = false;
  if (usage.webSearches !== undefined) total.webSearches = (total.webSearches ?? 0) + usage.webSearches;
}

/**
 * Wrap a raw transport into an `AiProvider`: schema conversion, zod validation, and the single
 * retry with the validation errors. Provider-level failures (timeout, auth, ...) are not
 * retried here; the router moves on to the next provider.
 */
export function createProvider(transport: AiTransport, kind: AiProviderKind = AI_PROVIDER_KIND[transport.id]): AiProvider {
  return {
    id: transport.id,
    kind,
    availability: () => transport.availability(),
    async run<T>(task: AiTask, prompt: AiPrompt, schema: ZodType<T>, opts: AiRunOptions = {}): Promise<AiProviderResult<T>> {
      const jsonSchema = toJsonSchema(schema);
      const total: AiTokenUsage = { tokensIn: 0, tokensOut: 0 };
      let model = "";
      let current = prompt;
      let lastProblem = "";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const request: AiTransportRequest = {
          task,
          system: current.system,
          user: current.user,
          jsonSchema,
          strong: opts.strong ?? false,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.web ? { web: opts.web } : {}),
        };
        const planned = transport.plannedModel?.(request);
        const requested = planned ? { requested: planned } : {};
        const started = performance.now();
        let response;
        try {
          response = await transport.call(request);
        } catch (error) {
          // A call that failed is still a call; a cancelled one is not.
          if (error instanceof AiProviderError && error.kind !== "aborted") {
            // a reply that arrived but was unusable (empty) still carries its usage: it is billed, so it is counted
            opts.onCall?.({
              model: error.model ?? planned ?? null,
              ...requested,
              usage: error.usage ?? { tokensIn: 0, tokensOut: 0, reported: false },
              durationMs: Math.max(0, Math.round(performance.now() - started)),
              outcome: "failed",
              errorKind: error.kind,
            });
          }
          throw error;
        }
        const durationMs = Math.max(0, Math.round(performance.now() - started));
        model = response.model;
        addUsage(total, response.usage);
        const checked = validate(schema, response.text);
        opts.onCall?.({ model: response.model, ...requested, usage: response.usage, durationMs, outcome: checked.ok ? "ok" : "invalid_output" });
        if (checked.ok) return { value: checked.value, provider: transport.id, model, usage: total };
        lastProblem = checked.problem;
        current = retryPrompt(prompt, response.text, checked.problem);
      }
      throw new AiProviderError(transport.id, "invalid_output", `output failed validation twice: ${lastProblem}`);
    },
  };
}
