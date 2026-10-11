import { CHANNEL_ERROR_CODES, type ChannelErrorCode } from "./types";

export { CHANNEL_ERROR_CODES, type ChannelErrorCode };

/** Whether retrying the same request may help, per code. Individual errors can override it. */
const DEFAULT_RETRYABLE: Record<ChannelErrorCode, boolean> = {
  rate_limited: true,
  network: true,
  blocked: false,
  auth_expired: false,
  budget_exceeded: false,
  parse: false,
  unknown: false,
};

export interface ChannelErrorOptions {
  retryable?: boolean;
  /** HTTP status that caused the error, if any. */
  status?: number;
  /** Server-requested wait (Retry-After), in ms. */
  retryAfterMs?: number;
  /** One occurrence is enough to open the circuit (e.g. the provider's monthly quota is used up): waiting for more failures only wastes cycles. */
  tripsCircuit?: boolean;
  cause?: unknown;
}

/**
 * Classified channel failure. The code drives retries, the circuit breaker and the cascade; the
 * message must never contain secrets, headers or response bodies (C4).
 */
export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly tripsCircuit: boolean;

  constructor(code: ChannelErrorCode, message: string, options: ChannelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChannelError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.tripsCircuit = options.tripsCircuit ?? false;
  }
}

/**
 * Our own plumbing failed (database write, bug in the runner), not the channel. Never counted
 * against a channel's circuit and never triggers a cascade fallback.
 */
export class InfrastructureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InfrastructureError";
  }
}

export type BudgetScope = "channel" | "global";

/** Raised when a channel or the global paid cap would be exceeded. Never retryable. */
export class BudgetExceededError extends ChannelError {
  readonly scope: BudgetScope;

  constructor(scope: BudgetScope, message: string) {
    super("budget_exceeded", message);
    this.name = "BudgetExceededError";
    this.scope = scope;
  }
}

/** Page markers that mean "you were detected as a bot / must log in", whatever the status code. */
const BLOCK_MARKERS = /captcha|authwall|unusual traffic|verify you are (?:a )?human|are you a robot|security check|access denied|challenge-platform/i;

/** True when a response body looks like a bot-detection or verification page. */
export function looksBlocked(body: string): boolean {
  return BLOCK_MARKERS.test(body);
}

/** Non-standard "request denied" status LinkedIn answers bots with. */
const LINKEDIN_DENIED_STATUS = 999;

/** Map an HTTP status (and an optional body excerpt) to a ChannelError. Returns null for statuses < 400 without block markers. */
export function errorFromHttp(
  status: number,
  context: { bodyExcerpt?: string; retryAfterMs?: number; where?: string } = {},
): ChannelError | null {
  const where = context.where ? ` from ${context.where}` : "";
  const extra = { status, ...(context.retryAfterMs === undefined ? {} : { retryAfterMs: context.retryAfterMs }) };
  if (status === 429) return new ChannelError("rate_limited", `HTTP 429${where}: rate limited`, extra);
  if (status === 401) return new ChannelError("auth_expired", `HTTP 401${where}: authentication expired or missing`, extra);
  if (status === 403 || status === LINKEDIN_DENIED_STATUS) {
    return new ChannelError("blocked", `HTTP ${status}${where}: request blocked`, extra);
  }
  if (status >= 400 && context.bodyExcerpt !== undefined && looksBlocked(context.bodyExcerpt)) {
    return new ChannelError("blocked", `HTTP ${status}${where}: verification page`, extra);
  }
  if (status === 408 || status >= 500) return new ChannelError("network", `HTTP ${status}${where}: server error`, extra);
  if (status >= 400) return new ChannelError("unknown", `HTTP ${status}${where}`, { ...extra, retryable: false });
  return null;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Normalize anything thrown by a channel into a ChannelError (keeps ChannelErrors as they are). */
export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  if (error instanceof Error) {
    return new ChannelError("unknown", `${error.name}: ${error.message}`.slice(0, 500), { cause: error });
  }
  return new ChannelError("unknown", "non-error value thrown");
}
