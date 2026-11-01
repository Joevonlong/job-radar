import { z } from "zod";

import type { AiMaxTokensField, AiOpenAiCompatibleProvider } from "@/lib/config/ai-options";
import { checkCredentialEndpoint } from "@/lib/credential-endpoints";

import { AiProviderError, registerSecret } from "../errors";
import { createProvider } from "../provider";
import type { AiAvailability, AiProvider, AiProviderId, AiTokenUsage, AiTransport, AiTransportRequest, AiTransportResponse } from "../types";

/** OpenRouter's `provider` request field (ai.yaml `providers.openrouter.routing`). */
export interface OpenRouterRouting {
  require_parameters: boolean;
  data_collection: "allow" | "deny";
  zdr: boolean;
}

export interface OpenAiCompatibleOptions {
  id: AiOpenAiCompatibleProvider;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  /** Name of the environment variable, for the "not set" message only. */
  keyName: string;
  /**
   * true: `response_format: {type: "json_object"}` and the JSON Schema is written into the prompt (MiMo, DeepSeek).
   * false: `response_format: {type: "json_schema", ...}` (strict).
   */
  jsonModeOnly: boolean;
  /** The request field that caps the reply length (default `max_tokens`). */
  maxTokensField?: AiMaxTokensField;
  /** OpenRouter only: sent as the request's `provider` field. */
  routing?: OpenRouterRouting;
  timeoutMs: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
  /** Environment for the endpoint check (default: process.env; see `checkCredentialEndpoint`). */
  env?: Readonly<Record<string, string | undefined>>;
}

const completionSchema = z.looseObject({
  model: z.string().optional(),
  choices: z
    .array(z.looseObject({ message: z.looseObject({ content: z.string().nullable().optional() }), finish_reason: z.string().nullable().optional() }))
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.looseObject({ cached_tokens: z.number().nullable().optional() }).nullable().optional(),
      /** DeepSeek's name for the cached part of the prompt. */
      prompt_cache_hit_tokens: z.number().nullable().optional(),
      completion_tokens_details: z.looseObject({ reasoning_tokens: z.number().nullable().optional() }).nullable().optional(),
      /** OpenRouter: what this request was charged, in credits (1 credit = 1 USD); checked by `reportedCost`. */
      cost: z.unknown().optional(),
    })
    .optional(),
});
type CompletionUsage = z.infer<typeof completionSchema>["usage"];
/** What is left of a reply whose choices do not fit the schema: its usage still counts. */
const usageOnlySchema = z.looseObject({ model: z.string().optional(), usage: completionSchema.shape.usage });
const errorBodySchema = z.looseObject({ error: z.looseObject({ message: z.string().optional() }).optional() });
/** OpenRouter can answer HTTP 200 with an error in place of the choices; its `code` is an HTTP status. */
const errorReplySchema = z.looseObject({ error: z.looseObject({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }) });

function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** JSON mode only guarantees *some* JSON object, so the schema has to be in the prompt. */
export function embedSchema(system: string, schema: unknown): string {
  return `${system}\n\nRespond with a single JSON object (no prose, no code fences) that conforms to this JSON Schema:\n${JSON.stringify(schema)}`;
}

function statusError(id: AiProviderId, status: number, bodyText: string): AiProviderError {
  let message = "";
  try {
    message = errorBodySchema.parse(JSON.parse(bodyText)).error?.message ?? "";
  } catch {
    // not JSON: leave the body out entirely
  }
  return errorFor(id, status, `HTTP ${status}${message ? `: ${message}` : ""}`);
}

/** The error kind of an HTTP status, or of the status OpenRouter puts in an error reply's `code`. */
function errorFor(id: AiProviderId, status: number, detail: string, extra: { usage?: AiTokenUsage; model?: string } = {}): AiProviderError {
  // 402 = insufficient balance on DeepSeek and OpenRouter: as unusable as a bad key.
  if (status === 401 || status === 402 || status === 403) return new AiProviderError(id, "auth", detail, extra);
  if (status === 429) return new AiProviderError(id, "rate_limited", detail, extra);
  return new AiProviderError(id, "provider_error", detail, extra);
}

/** A charge the reply reported: a finite, non-negative number (0 included); anything else is no charge, and the catalog prices the call. */
function reportedCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function openAiUsage(usage: CompletionUsage): AiTokenUsage {
  const cost = reportedCost(usage?.cost);
  const charged = cost !== undefined ? { reportedCostUsd: cost } : {};
  if (usage?.prompt_tokens === undefined || usage.completion_tokens === undefined) return { tokensIn: 0, tokensOut: 0, reported: false, ...charged };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    tokensIn: usage.prompt_tokens,
    tokensOut: usage.completion_tokens,
    ...(cached !== null && cached !== undefined ? { cachedIn: cached } : {}),
    ...(reasoning !== null && reasoning !== undefined ? { reasoningOut: reasoning } : {}),
    ...charged,
  };
}

/** The usage a reply carried, for a call that fails after the reply arrived; undefined when there was none. */
function usageOf(usage: CompletionUsage): AiTokenUsage | undefined {
  const counted = openAiUsage(usage);
  return counted.reported === false && counted.reportedCostUsd === undefined ? undefined : counted;
}

/** OpenAI, OpenRouter, DeepSeek and MiMo: one OpenAI-compatible chat-completions client over plain `fetch`. */
export function createOpenAiCompatibleTransport(options: OpenAiCompatibleOptions): AiTransport {
  const { id } = options;
  registerSecret(options.apiKey);
  const doFetch = options.fetch ?? fetch;
  // The key goes only to the vendor's own host unless the user opted in (the base URL is editable from the web UI).
  const endpoint = checkCredentialEndpoint(id, options.baseUrl, options.env ?? process.env);
  const refused = endpoint.status === "refused" ? endpoint.message : null;
  return {
    id,
    availability(): AiAvailability {
      if (refused !== null) return { available: false, reason: refused };
      return options.apiKey ? { available: true } : { available: false, reason: `${options.keyName} not set` };
    },
    plannedModel: (request) => request.model ?? options.model,
    async call(request: AiTransportRequest): Promise<AiTransportResponse> {
      if (refused !== null) throw new AiProviderError(id, "not_configured", refused);
      if (!options.apiKey) throw new AiProviderError(id, "not_configured", `${options.keyName} not set`);
      const timeoutMs = request.timeoutMs ?? options.timeoutMs;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const model = request.model ?? options.model;
      const body = {
        model,
        [options.maxTokensField ?? "max_tokens"]: request.maxOutputTokens ?? options.maxOutputTokens,
        messages: [
          { role: "system", content: options.jsonModeOnly ? embedSchema(request.system, request.jsonSchema) : request.system },
          { role: "user", content: request.user },
        ],
        response_format: options.jsonModeOnly
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: "answer", strict: true, schema: request.jsonSchema } },
        ...(options.routing
          ? {
              provider: {
                require_parameters: options.routing.require_parameters,
                data_collection: options.routing.data_collection,
                // only sent when asked for: false is OpenRouter's default
                ...(options.routing.zdr ? { zdr: true } : {}),
              },
            }
          : {}),
      };
      let response: Response;
      try {
        response = await doFetch(completionsUrl(options.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
          signal,
          // the key must not follow a redirect to another host
          redirect: "error",
        });
      } catch (error) {
        if (request.signal?.aborted) throw new AiProviderError(id, "aborted", "cancelled");
        if (timeout.aborted) throw new AiProviderError(id, "timeout", `timed out after ${Math.round(timeoutMs / 1000)}s`);
        throw new AiProviderError(id, "network", error instanceof Error ? `${error.name}: ${error.message}` : "request failed");
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) throw statusError(id, response.status, text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiProviderError(id, "provider_error", "unexpected response shape");
      }
      const parsed = completionSchema.safeParse(json);
      if (!parsed.success) {
        // the tokens of a reply are paid for even when its choices are unusable
        const partial = usageOnlySchema.safeParse(json);
        const usage = partial.success ? usageOf(partial.data.usage) : undefined;
        const extra = { ...(usage ? { usage } : {}), ...(partial.success && partial.data.model ? { model: partial.data.model } : {}) };
        const failure = errorReplySchema.safeParse(json);
        if (failure.success) {
          const { code, message } = failure.data.error;
          const status = Number(code);
          throw errorFor(id, Number.isInteger(status) ? status : 0, `error ${code ?? "without a code"}${message ? `: ${message}` : ""}`, extra);
        }
        throw new AiProviderError(id, "provider_error", "unexpected response shape", extra);
      }
      const answered = parsed.data.model ?? model;
      const content = parsed.data.choices[0]?.message.content;
      if (content === null || content === undefined || content.trim() === "") {
        const usage = usageOf(parsed.data.usage);
        throw new AiProviderError(id, "invalid_output", "empty reply", { ...(usage ? { usage } : {}), model: answered });
      }
      return { text: content, model: answered, usage: openAiUsage(parsed.data.usage) };
    },
  };
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): AiProvider {
  return createProvider(createOpenAiCompatibleTransport(options));
}
