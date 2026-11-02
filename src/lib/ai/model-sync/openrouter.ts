import { z } from "zod";

import type { AiMaxTokensField } from "@/lib/config/ai-options";
import { checkCredentialEndpoint } from "@/lib/credential-endpoints";

import { AiProviderError } from "../errors";

import type { ListedModel } from "./types";

/** USD per token as a string (OpenRouter) or a number; anything else, a negative number (a router's "-1") or NaN is no price. */
const perToken = z.union([z.string(), z.number()]).optional();

const modelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  context_length: z.number().nullable().optional(),
  architecture: z
    .looseObject({ input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() })
    .nullable()
    .optional(),
  pricing: z
    .looseObject({ prompt: perToken, completion: perToken, input_cache_read: perToken, input_cache_write: perToken })
    .nullable()
    .optional(),
  supported_parameters: z.array(z.string()).nullable().optional(),
  expiration_date: z.string().nullable().optional(),
});
const listSchema = z.looseObject({ data: z.array(z.unknown()) });

/** One decimal figure of a per-token price as USD per million tokens (6 significant digits: `0.000000045` -> 0.045). */
function perMillion(value: string | number | undefined): number | undefined {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return Number((n * 1_000_000).toPrecision(6));
}

function priceOf(pricing: z.infer<typeof modelSchema>["pricing"]): ListedModel["price"] {
  if (!pricing) return null;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === undefined || output === undefined || Number.isNaN(input) || Number.isNaN(output)) return null;
  const cached = perMillion(pricing.input_cache_read);
  const write = perMillion(pricing.input_cache_write);
  return {
    input_per_mtok: input,
    output_per_mtok: output,
    ...(cached !== undefined && !Number.isNaN(cached) ? { cached_input_per_mtok: cached } : {}),
    ...(write !== undefined && !Number.isNaN(write) ? { cache_write_per_mtok: write } : {}),
  };
}

/**
 * Whether the model takes JSON mode. OpenRouter lists `response_format` in `supported_parameters` of models that do. A model of
 * OpenAI's own family must also take the length cap field this provider sends (`max_tokens_field`), else the request would fail.
 */
function jsonSupport(model: z.infer<typeof modelSchema>, maxTokensField: AiMaxTokensField): ListedModel["json"] {
  const parameters = model.supported_parameters;
  if (!parameters || parameters.length === 0) return "unverified";
  if (!parameters.includes("response_format")) return "no";
  if (model.id.startsWith("openai/") && !parameters.includes(maxTokensField)) return "unverified";
  return "yes";
}

/** The model as the catalog sees it; a model with no usable shape gives null. */
export function listedFrom(raw: unknown, maxTokensField: AiMaxTokensField): ListedModel | null {
  const parsed = modelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const model = parsed.data;
  const inputs = model.architecture?.input_modalities;
  const outputs = model.architecture?.output_modalities;
  const date = model.expiration_date && /^\d{4}-\d{2}-\d{2}/.test(model.expiration_date) ? model.expiration_date.slice(0, 10) : null;
  return {
    id: model.id,
    name: model.name ?? model.id,
    textChat: inputs?.includes("text") === true && outputs !== undefined && outputs.length === 1 && outputs[0] === "text",
    price: priceOf(model.pricing),
    contextLength: typeof model.context_length === "number" && model.context_length >= 0 ? Math.round(model.context_length) : null,
    json: jsonSupport(model, maxTokensField),
    expiresOn: date,
  };
}

export interface OpenRouterListOptions {
  baseUrl: string;
  maxTokensField: AiMaxTokensField;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * OpenRouter's public model list (`GET <base_url>/models`, no key). The URL is `ai.yaml`'s `base_url` and goes through the same
 * endpoint check as the chat calls; redirects are errors. Errors name only the kind of failure, never the reply.
 */
export async function listOpenRouterModels(options: OpenRouterListOptions): Promise<ListedModel[]> {
  const id = "openrouter";
  const endpoint = checkCredentialEndpoint(id, options.baseUrl, options.env ?? process.env);
  if (endpoint.status === "refused") throw new AiProviderError(id, "not_configured", endpoint.message);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", headers: { accept: "application/json" }, signal, redirect: "error" });
  } catch (error) {
    if (options.signal?.aborted) throw new AiProviderError(id, "aborted", "cancelled");
    if (timeout.aborted) throw new AiProviderError(id, "timeout", `timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    throw new AiProviderError(id, "network", error instanceof Error ? error.name : "request failed");
  }
  if (!response.ok) throw new AiProviderError(id, response.status === 429 ? "rate_limited" : "provider_error", `HTTP ${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new AiProviderError(id, "provider_error", "unexpected response shape");
  }
  const list = listSchema.safeParse(json);
  if (!list.success) throw new AiProviderError(id, "provider_error", "unexpected response shape");
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const raw of list.data.data) {
    const listed = listedFrom(raw, options.maxTokensField);
    if (listed === null || seen.has(listed.id)) continue;
    seen.add(listed.id);
    models.push(listed);
  }
  if (models.length === 0) throw new AiProviderError(id, "provider_error", "no models in the response");
  return models;
}
