import { CHANNEL_ERROR_CODES, type ChannelBudget, type ChannelErrorCode, type RawPostingInput } from "./types";

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

/**
 * A paginated query that got some pages and then failed (a later page or keyword): the postings already fetched
 * plus the original failure. The runner stores the postings and then treats `cause` exactly like a plain failure
 * (circuit, cascade, retry), recording the run as an interrupted partial. Only thrown with at least one posting;
 * when nothing was fetched yet the channel throws `cause` itself.
 *
 * `planned` marks a stop the plan itself asked for rather than a failure: the next request was refused by the channel's own
 * budget before it was sent (`cause` is then a budget error). The runner stores the postings and records the run as skipped,
 * not as an interruption: no failure is counted and the circuit is left alone. For any other cause the flag changes nothing.
 */
export class PartialCollectError extends Error {
  readonly postings: readonly RawPostingInput[];
  override readonly cause: ChannelError;
  readonly planned: boolean;

  constructor(postings: readonly RawPostingInput[], cause: ChannelError, options: { planned?: boolean } = {}) {
    super(`interrupted after ${postings.length} postings: ${cause.message}`, { cause });
    this.name = "PartialCollectError";
    this.postings = postings;
    this.cause = cause;
    this.planned = options.planned ?? false;
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

/**
 * Books a query's postings against the budget and hands them back. When the query was cut short (`interrupted`), it
 * throws `PartialCollectError` with that cause instead, and a budget refusal does not replace it: the postings were
 * already read, so they are kept and the run reports why the query stopped. Any other error from the budget propagates.
 */
export async function settlePostings(
  budget: Pick<ChannelBudget, "consume">,
  postings: RawPostingInput[],
  interrupted: ChannelError | null,
): Promise<RawPostingInput[]> {
  if (!interrupted) {
    await budget.consume(postings.length);
    return postings;
  }
  try {
    await budget.consume(postings.length);
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
  }
  throw new PartialCollectError(postings, interrupted);
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

/** Normalize anything thrown by a channel into a ChannelError (keeps ChannelErrors as they are; an interrupted query yields its original failure). */
export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  if (error instanceof PartialCollectError) return error.cause;
  if (error instanceof Error) {
    return new ChannelError("unknown", `${error.name}: ${error.message}`.slice(0, 500), { cause: error });
  }
  return new ChannelError("unknown", "non-error value thrown");
}
