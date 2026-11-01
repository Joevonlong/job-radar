import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { Message, MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages/messages";

import type { AiConfig } from "@/lib/config";

import { AiProviderError, registerSecret } from "../errors";
import { createProvider } from "../provider";
import type { AiAvailability, AiProvider, AiTokenUsage, AiTransport, AiTransportRequest, AiTransportResponse } from "../types";
import { safeDomains, webAccessAllowed } from "../web-tasks";

/** The tool whose input is the structured answer. */
const TOOL_NAME = "respond";
const RESPOND_INSTRUCTION = "Answer only by calling the respond tool.";
/** A web task's turn the API paused (`stop_reason: pause_turn`) is continued at most this many times. */
export const MAX_PAUSE_CONTINUATIONS = 4;

export type AnthropicConfig = AiConfig["providers"]["anthropic"];

export interface AnthropicOptions {
  config: AnthropicConfig;
  apiKey: string | undefined;
  timeoutMs: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
}

function classify(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof APIUserAbortError) return new AiProviderError("anthropic", "aborted", "cancelled");
  if (error instanceof APIConnectionTimeoutError) return new AiProviderError("anthropic", "timeout", "request timed out");
  if (error instanceof APIError) {
    const status = error.status;
    // Only the status and the API's own error message: never headers or the request.
    const detail = `HTTP ${status ?? "?"}: ${error.message}`;
    if (status === 401 || status === 403) return new AiProviderError("anthropic", "auth", detail);
    if (status === 429) return new AiProviderError("anthropic", "rate_limited", detail);
    if (status === undefined) return new AiProviderError("anthropic", "network", detail);
    return new AiProviderError("anthropic", "provider_error", detail);
  }
  return new AiProviderError("anthropic", "provider_error", error instanceof Error ? error.message : "request failed");
}

/**
 * anthropic: the official SDK. Structured output through tool use: one tool whose `input_schema` is the
 * JSON Schema, automatic tool choice, and a system instruction to answer with `respond`. Thinking configuration
 * is omitted for model compatibility.
 * The SDK's own retry is disabled; fallback and the validation retry are the router's business.
 */
export function createAnthropicTransport(options: AnthropicOptions): AiTransport {
  const { config } = options;
  registerSecret(options.apiKey);
  let client: Anthropic | null = null;
  const getClient = (apiKey: string): Anthropic => {
    client ??= new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return client;
  };
  return {
    id: "anthropic",
    availability(): AiAvailability {
      return options.apiKey ? { available: true } : { available: false, reason: "ANTHROPIC_API_KEY not set" };
    },
    plannedModel: (request) => request.model ?? (request.strong ? config.strong_model : config.model),
    async call(request: AiTransportRequest): Promise<AiTransportResponse> {
      if (!options.apiKey) throw new AiProviderError("anthropic", "not_configured", "ANTHROPIC_API_KEY not set");
      const model = request.model ?? (request.strong ? config.strong_model : config.model);
      // The server-side web search, for a web task only (the policy decides, `request.web` only sets the limits)
      if (webAccessAllowed(request.task, "anthropic")) return callWithWebSearch(getClient(options.apiKey), request, model, request.maxOutputTokens ?? options.maxOutputTokens);
      try {
        const message = await getClient(options.apiKey).messages.create(
          {
            model,
            max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
            system: `${request.system}\n\n${RESPOND_INSTRUCTION}`,
            messages: [{ role: "user", content: request.user }],
            tools: [respondTool(request)],
            tool_choice: { type: "auto" },
          },
          { ...(request.signal ? { signal: request.signal } : {}), ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}) },
        );
        return {
          text: extractAnswer(message),
          model: message.model,
          usage: {
            tokensIn: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
            tokensOut: message.usage.output_tokens,
            cachedIn: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteIn: message.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (error) {
        throw classify(error);
      }
    },
  };
}

const respondTool = (request: AiTransportRequest): ToolUnion => ({
  name: TOOL_NAME,
  description: "Return the answer. The input must match the schema exactly.",
  input_schema: request.jsonSchema,
});

function extractAnswer(message: Message): string {
  const toolUse = message.content.find((block) => block.type === "tool_use" && block.name === TOOL_NAME);
  const text =
    toolUse?.type === "tool_use"
      ? JSON.stringify(toolUse.input)
      : message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim();
  return text === "" ? `(no answer; stop_reason ${message.stop_reason ?? "?"})` : text;
}

function addMessageUsage(total: AiTokenUsage, message: Message): void {
  const usage = message.usage;
  const cachedIn = usage.cache_read_input_tokens ?? 0;
  const cacheWriteIn = usage.cache_creation_input_tokens ?? 0;
  total.tokensIn += usage.input_tokens + cachedIn + cacheWriteIn;
  total.tokensOut += usage.output_tokens;
  total.cachedIn = (total.cachedIn ?? 0) + cachedIn;
  total.cacheWriteIn = (total.cacheWriteIn ?? 0) + cacheWriteIn;
  total.webSearches = (total.webSearches ?? 0) + (usage.server_tool_use?.web_search_requests ?? 0);
}

/**
 * A web task. The model may call the server-side `web_search` tool (at most the run's remaining search budget,
 * results only from the allowed domains; an empty or invalid domain list is refused) before it answers with the `respond` tool, so the tool choice is `auto` (a forced
 * tool cannot search first). A paused turn is continued up to `MAX_PAUSE_CONTINUATIONS` times. No `respond` call in the
 * end: the reply's text goes back as the answer, so the validation retry of `createProvider` asks once more (a failed
 * search shows up as such a reply too). Searches are counted in `usage.webSearches` and taken off the shared budget.
 */
async function callWithWebSearch(client: Anthropic, request: AiTransportRequest, model: string, maxTokens: number): Promise<AiTransportResponse> {
  const budget = request.web?.budget;
  const searches = Math.max(0, Math.min(request.web?.maxSearches ?? 0, budget?.remaining ?? 0));
  const domains = safeDomains(request.web?.allowedDomains ?? []);
  // without a domain list the search would be unrestricted: refuse instead (the next provider of the plan may still run)
  if (domains.length === 0) throw new AiProviderError("anthropic", "not_configured", "web search needs at least one allowed domain (salary.yaml: lookup.allowed_fetch_domains)");
  const toolsFor = (maxUses: number): ToolUnion[] =>
    maxUses > 0 ? [respondTool(request), { type: "web_search_20250305", name: "web_search", max_uses: maxUses, allowed_domains: domains }] : [respondTool(request)];
  const messages: MessageParam[] = [{ role: "user", content: request.user }];
  const usage: AiTokenUsage = { tokensIn: 0, tokensOut: 0 };
  let message: Message | null = null;
  let left = searches;
  try {
    for (let turn = 0; turn <= MAX_PAUSE_CONTINUATIONS; turn += 1) {
      // a continued turn may only search what is left of the run's budget; with none left the paused turn is not continued
      if (turn > 0 && left <= 0) break;
      const tools = toolsFor(left);
      message = await client.messages.create(
        { model, max_tokens: maxTokens, system: `${request.system}\n\n${RESPOND_INSTRUCTION}`, messages, tools, tool_choice: { type: "auto" } },
        { ...(request.signal ? { signal: request.signal } : {}), ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}) },
      );
      const before = usage.webSearches ?? 0;
      addMessageUsage(usage, message);
      const used = (usage.webSearches ?? 0) - before;
      left = Math.max(0, left - used);
      if (budget) budget.remaining = Math.max(0, budget.remaining - used);
      if (message.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: message.content });
    }
  } catch (error) {
    throw classify(error);
  }
  if (!message) throw new AiProviderError("anthropic", "provider_error", "no reply");
  return { text: extractAnswer(message), model: message.model, usage };
}

export function createAnthropicProvider(options: AnthropicOptions): AiProvider {
  return createProvider(createAnthropicTransport(options));
}
