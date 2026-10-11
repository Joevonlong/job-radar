import { AiProviderError, AiUnavailableError, QUOTA_GUARD_CODE, quotaGuardResume, sanitize } from "@/lib/ai/errors";

/** Why a translation (or one piece of it) did not come back. The web page shows a message per code. */
export const TRANSLATION_FAILURE_CODES = ["auth", "timeout", "rate_limited", "invalid_output", "provider_error", "network", "budget", QUOTA_GUARD_CODE, "unavailable", "failed"] as const;
export type TranslationFailureCode = (typeof TRANSLATION_FAILURE_CODES)[number];

export interface TranslationFailure {
  code: TranslationFailureCode;
  /** Short, sanitized: which provider failed how (no secrets, no text of the JD). */
  message: string;
  /** Every provider failed or was skipped for a reason that will hit the next piece too (nothing configured, login expired, down). */
  providerWide: boolean;
  /** With `quota_guard`: when Job Radar's usage cap is expected to let the AI work again (ISO; null = not known). */
  resumeAt?: string | null;
}

/** Most telling first: a login problem explains more than the timeout that followed. */
const PRIORITY: readonly TranslationFailureCode[] = ["auth", "timeout", "rate_limited", "invalid_output", "provider_error", "network", "budget"];

/**
 * Name the real cause of a failed piece. `AiUnavailableError` carries one attempt per provider: when every one of
 * them was only skipped as "not configured", nothing is available; otherwise the most telling failure wins.
 */
export function classifyTranslationFailure(error: unknown): TranslationFailure {
  if (error instanceof TranslationIncompleteError) return error.failure;
  if (error instanceof AiUnavailableError) {
    // Job Radar's own usage cap (or a limit the provider reported) held the AI back: say so, with the expected time
    const capped = quotaGuardResume(error);
    if (capped) return { code: QUOTA_GUARD_CODE, message: sanitize(error.attempts.map((a) => `${a.provider}: ${a.guard?.reason ?? a.kind}`).join("; ")), providerWide: true, resumeAt: capped.resumeAt };
    const real = error.attempts.filter((a) => a.kind !== "not_configured");
    if (real.length === 0) return { code: "unavailable", message: "no provider is configured or available", providerWide: true };
    const message = sanitize(real.map((a) => `${a.provider}: ${a.kind}`).join("; "));
    const kind = PRIORITY.find((k) => real.some((a) => a.kind === k));
    const code: TranslationFailureCode = kind ?? "failed";
    return { code, message, providerWide: !real.some((a) => a.kind === "invalid_output") };
  }
  if (error instanceof AiProviderError) {
    const code = TRANSLATION_FAILURE_CODES.find((c) => c === error.kind) ?? "failed";
    return { code, message: `${error.provider}: ${error.kind}`, providerWide: true };
  }
  return { code: "failed", message: error instanceof Error ? sanitize(`${error.name}: ${error.message}`) : "unexpected error", providerWide: true };
}

/** Some pieces of a JD are translated and saved, the rest is not: a retry continues with the missing ones. */
export class TranslationIncompleteError extends Error {
  readonly failure: TranslationFailure;
  readonly done: number;
  readonly total: number;

  constructor(failure: TranslationFailure, done: number, total: number) {
    super(`translation incomplete (${done}/${total} pieces): ${failure.code}: ${failure.message}`);
    this.name = "TranslationIncompleteError";
    this.failure = failure;
    this.done = done;
    this.total = total;
  }
}

/** `{ resumeAt }` for a request result when the usage cap stopped the work, else nothing. */
export function resumeOf(failure: TranslationFailure): { resumeAt: string | null } | Record<string, never> {
  return failure.resumeAt !== undefined ? { resumeAt: failure.resumeAt } : {};
}
