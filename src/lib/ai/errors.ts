import type { AiProviderId, AiTask } from "./types";

/** Environment variables that hold provider credentials. Their values are masked in every message (C4). */
export const SECRET_ENV_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MIMO_API_KEY"] as const;

/** Credentials handed to providers at runtime (they may not come from process.env, e.g. in tests or probes). */
const registeredSecrets = new Set<string>();

/** Make `sanitize` mask `value` too. Providers call this for the key/token they were given. */
export function registerSecret(value: string | undefined): void {
  if (value !== undefined && value.length >= 6) registeredSecrets.add(value);
}

const MAX_MESSAGE = 400;
/** Generic credential shapes, in case a provider echoes a key that is not in the environment. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[-_]?key|token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Mask credentials and shorten `text` so it can go into an error message, log line or `ai_usage`. */
export function sanitize(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined && value.length >= 6) out = out.split(value).join("[redacted]");
  }
  for (const value of registeredSecrets) out = out.split(value).join("[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/** Wording of "you are out of quota / session / rate limit" in the claude and codex CLIs and in API error bodies. */
export const QUOTA_PATTERN =
  /rate.?limit|usage limit|session limit|hit your (?:\w+ )?limit|limit reached|limit will reset|too many requests|quota|out of (?:credits|usage)|usage cap|insufficient_quota/i;

export type AiProviderErrorKind =
  | "not_configured"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "invalid_output"
  | "budget"
  | "aborted";

/** Failure of one provider. The message is sanitized on construction. */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly provider: AiProviderId;

  constructor(provider: AiProviderId, kind: AiProviderErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(sanitize(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiProviderError";
    this.provider = provider;
    this.kind = kind;
  }
}

/** The zod schema cannot be expressed as JSON Schema (a bug in the caller, not a provider problem). */
export class AiSchemaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSchemaError";
  }
}

/** The reason / error code used wherever Job Radar's own AI usage cap stopped the work (step result, control requests). */
export const QUOTA_GUARD_CODE = "quota_guard";

/** Set when Job Radar's own usage cap (ai.yaml `quota_guard`) held the provider back: why, and when it is expected back. */
export interface AiQuotaGuardMark {
  reason: "window" | "cycle_cap" | "error";
  /** ISO time; null = not known (the per-cycle cap: the next cycle). */
  resumeAt: string | null;
}

export interface AiAttempt {
  provider: AiProviderId;
  outcome: "skipped" | "failed";
  kind: AiProviderErrorKind;
  message: string;
  guard?: AiQuotaGuardMark;
}

/** Every provider in the plan was skipped or failed. */
export class AiUnavailableError extends Error {
  readonly task: AiTask;
  readonly attempts: readonly AiAttempt[];

  constructor(task: AiTask, attempts: readonly AiAttempt[]) {
    const detail =
      attempts.length === 0
        ? "no provider in the plan"
        : attempts.map((a) => `${a.provider} ${a.outcome} (${a.kind}${a.message ? `: ${a.message}` : ""})`).join("; ");
    // Attempt messages were sanitized where they were created.
    super(`no AI provider could handle task "${task}": ${detail}`);
    this.name = "AiUnavailableError";
    this.task = task;
    this.attempts = attempts;
  }
}

/** The attempts the usage cap held back (empty = the cap played no part). */
export function quotaGuardAttempts(attempts: readonly AiAttempt[]): (AiAttempt & { guard: AiQuotaGuardMark })[] {
  return attempts.filter((a): a is AiAttempt & { guard: AiQuotaGuardMark } => a.guard !== undefined);
}

/** Failures that need the user (a login) or say something went wrong on a call: they outrank the usage cap's skip. */
const ACTIONABLE_KINDS: readonly AiProviderErrorKind[] = ["auth", "timeout", "network", "provider_error", "invalid_output"];

/**
 * Whether `error` means "the usage cap holds the AI back": every provider was skipped or failed, at least one of them
 * was held back by the cap, and no other provider failed for a more actionable reason (a provider that is not logged in
 * must still surface as such). Returns the earliest expected resume time (null = unknown / the next cycle), or undefined
 * when the cap played no part or something more actionable explains the failure.
 */
export function quotaGuardResume(error: unknown): { resumeAt: string | null } | undefined {
  if (!(error instanceof AiUnavailableError)) return undefined;
  const guarded = quotaGuardAttempts(error.attempts);
  if (guarded.length === 0) return undefined;
  if (error.attempts.some((a) => a.guard === undefined && ACTIONABLE_KINDS.includes(a.kind))) return undefined;
  return { resumeAt: earliestResume(guarded.map((a) => a.guard.resumeAt)) };
}

/** The earliest of the known times; null when none is known. */
export function earliestResume(times: readonly (string | null)[]): string | null {
  let best: number | null = null;
  for (const time of times) {
    if (time === null) continue;
    const at = new Date(time).getTime();
    if (!Number.isNaN(at) && (best === null || at < best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}
