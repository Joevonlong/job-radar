import type { ZodType } from "zod";

import type { AiProviderIdChoice, AiProviderKindName } from "@/lib/config/ai-options";

import type { AiAttempt, AiProviderErrorKind } from "./errors";
import type { WebAccessLimits } from "./web-tasks";

/** The task kinds; each may override the provider order in ai.yaml. */
export const AI_TASKS = ["score", "signals", "translate", "summarize", "suggest", "breakdown", "traps", "salary_lookup"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export { AI_PROVIDER_IDS, AI_PROVIDER_KIND } from "@/lib/config/ai-options";
export type AiProviderId = AiProviderIdChoice;

/** `cli` providers run on a subscription (cost 0); `api` providers are pay-per-token and budget-capped. */
export type AiProviderKind = AiProviderKindName;

export interface AiPrompt {
  system: string;
  user: string;
}

/**
 * Token usage of a call. `tokensIn` is all input (including `cachedIn` and `cacheWriteIn`); `tokensOut` is all output
 * (including `reasoningOut`). The optional sub-counts are absent when the provider did not break them out.
 */
export interface AiTokenUsage {
  tokensIn: number;
  tokensOut: number;
  /** Part of `tokensIn` read from the prompt cache. */
  cachedIn?: number;
  /** Part of `tokensIn` written to the prompt cache. */
  cacheWriteIn?: number;
  /** Part of `tokensOut` spent on reasoning / thinking. */
  reasoningOut?: number;
  /** false = the reply carried no usage information (`tokensIn` / `tokensOut` are 0 placeholders, stored as unknown). Absent = true. */
  reported?: boolean;
  /** server-side web searches the call made (anthropic `server_tool_use.web_search_requests`); priced apart from the tokens. */
  webSearches?: number;
  /**
   * What the provider says this call was charged, USD (OpenRouter `usage.cost`; always finite and >= 0). Present: it is the
   * call's cost in `ai_usage` and the monthly budget; absent: the cost is estimated from the catalog. Per call, never summed.
   */
  reportedCostUsd?: number;
}

/** A JSON Schema document with an object at its root (what every provider requires). */
export type JsonSchemaObject = { type: "object" } & Record<string, unknown>;

/** One raw model call: what the provider-specific transports receive. */
export interface AiTransportRequest {
  task: AiTask;
  system: string;
  user: string;
  jsonSchema: JsonSchemaObject;
  /** Use the provider's stronger model for this call. */
  strong: boolean;
  /** Use this model id instead of the provider's configured model / strong_model. */
  model?: string;
  signal?: AbortSignal;
  /** Overrides the provider's own timeout for this call (milliseconds). */
  timeoutMs?: number;
  /**
   * Limits for a web task (`web-tasks.ts`). Never a permission: a transport switches its web tools on only when
   * `webAccessAllowed(task, provider)` says so, and ignores this for every other task.
   */
  web?: WebAccessLimits;
}

/** What a transport returns: the model's answer as JSON text (not yet validated). */
export interface AiTransportResponse {
  text: string;
  model: string;
  usage: AiTokenUsage;
}

/** Reported once per real model call (also for calls whose output turned out to be invalid). */
export interface AiCallRecord {
  /** The model that answered; for a failed call the model that was planned (null when unknown). */
  model: string | null;
  /** The model the call asked for, when the provider knows it (a reply may name a dated snapshot of it). */
  requested?: string;
  usage: AiTokenUsage;
  durationMs: number;
  outcome: "ok" | "invalid_output" | "failed";
  /** Only for `failed`. */
  errorKind?: AiProviderErrorKind;
}

export interface AiRunOptions {
  /** Use the stronger model (anthropic `strong_model`, claude-cli `strong_model`). */
  strong?: boolean;
  /** Use this model id, overriding the provider's configured model / strong_model. */
  model?: string;
  signal?: AbortSignal;
  /** Called after every model call, so usage can be recorded even when the run fails later. */
  onCall?: (call: AiCallRecord) => void;
  /** Overrides each provider's configured timeout for this run (milliseconds). */
  timeoutMs?: number;
  /** The job this call is about (stored in `ai_usage.job_id`). */
  jobId?: number;
  /** Providers the router must not try for this run (they timed out or were rate limited a moment ago). */
  skipProviders?: readonly AiProviderId[];
  /** Called for every provider that was skipped or failed before the answer (or before the router gave up). */
  onAttempt?: (attempt: AiAttempt) => void;
  /** Only try providers that can search the web (`webCapable`); chooses providers, grants nothing. */
  requireWeb?: boolean;
  /** The limits passed to the transports of a web task (see `AiTransportRequest.web`). */
  web?: WebAccessLimits;
  /** USD per server-side web search (anthropic), added to the call's cost in `ai_usage` and the monthly budget. */
  webSearchCostUsd?: number;
}

export interface AiResult<T> {
  value: T;
  provider: AiProviderId;
  model: string;
  /** Tokens summed over every call of this run (the retry included); cost is estimated by the router. */
  usage: AiTokenUsage & { costUsd: number };
}

export interface AiAvailability {
  available: boolean;
  /** Why not (never contains secrets). */
  reason?: string;
}

/** The provider-level result: like `AiResult` before cost estimation. */
export interface AiProviderResult<T> {
  value: T;
  provider: AiProviderId;
  model: string;
  usage: AiTokenUsage;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly kind: AiProviderKind;
  /** Cheap, side-effect free check (key present, CLI installed). Does not call the model. */
  availability(): AiAvailability;
  /**
   * Ask the model and return the zod-validated answer. Invalid output is sent back once together
   * with the validation errors; if the second answer is invalid too the call fails with
   * `AiProviderError("invalid_output")`.
   */
  run<T>(task: AiTask, prompt: AiPrompt, schema: ZodType<T>, opts?: AiRunOptions): Promise<AiProviderResult<T>>;
}

/** The raw call a concrete provider implements; `createProvider` adds validation and the retry. */
export interface AiTransport {
  readonly id: AiProviderId;
  availability(): AiAvailability;
  call(request: AiTransportRequest): Promise<AiTransportResponse>;
  /** The model this call intends to use (recorded when the call fails before a reply names one); null = unknown. */
  plannedModel?(request: AiTransportRequest): string | null;
}
