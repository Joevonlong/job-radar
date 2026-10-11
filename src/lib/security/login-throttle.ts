/**
 * Failed-login limits, in process memory (a restart clears them; acceptable for one web process).
 *
 * Per key (`throttleKey`: the last `X-Forwarded-For` entry, else `direct`): `maxFailures` failures within `windowMs` lock
 * the key for `lockoutMs`. A successful login clears its key.
 *
 * Across all keys, so that rotating the source does not get around the limit: once `globalMaxFailures` failures within
 * the window are reached, every login has to wait after each further failure, `globalDelayMs` at first and twice as long
 * with each failure after that, at most `lockoutMs`. A refused attempt is not a failure (it never reaches the password
 * check), so a stream of attempts cannot push the wait further out; the wait ends once the failures age out of the
 * window. A request that already carries a valid session skips this wait (`skipGlobal`): somebody spraying passwords
 * cannot keep a signed-in owner from signing in again. The clock is injected (tests).
 */
export interface ThrottleLimits {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  globalMaxFailures: number;
  /** The first wait once `globalMaxFailures` is reached; doubles with each further failure, at most `lockoutMs`. */
  globalDelayMs: number;
}

export type ThrottleCheck = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface FailureOutcome {
  /** This failure locked its key. */
  locked: boolean;
  /** The wait every login now has (seconds), or null while the global limit is not reached. */
  globalDelaySeconds: number | null;
}

interface KeyState {
  failures: number[];
  lockedUntil: number;
}

/** Keys remembered at most; the oldest are dropped beyond this (bounded memory under a spray of forwarded addresses). */
const MAX_KEYS = 10_000;

export class LoginThrottle {
  private readonly keys = new Map<string, KeyState>();
  private globalFailures: number[] = [];
  private globalWaitUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private prune(list: number[], windowMs: number, at: number): number[] {
    return list.filter((time) => at - time < windowMs);
  }

  private retryAfter(until: number, at: number): ThrottleCheck {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((until - at) / 1000)) };
  }

  /** May this key try now? `skipGlobal`: the request holds a valid session (only its own key's lock applies). */
  check(key: string, options: { skipGlobal?: boolean } = {}): ThrottleCheck {
    const at = this.now();
    if (options.skipGlobal !== true && this.globalWaitUntil > at) return this.retryAfter(this.globalWaitUntil, at);
    const state = this.keys.get(key);
    if (state !== undefined && state.lockedUntil > at) return this.retryAfter(state.lockedUntil, at);
    return { allowed: true };
  }

  /** Count a failed attempt: whether it locked its key, and the wait every login has now. */
  recordFailure(key: string, limits: ThrottleLimits): FailureOutcome {
    const at = this.now();
    let locked = false;
    const state = this.keys.get(key) ?? { failures: [], lockedUntil: 0 };
    state.failures = [...this.prune(state.failures, limits.windowMs, at), at];
    if (state.failures.length >= limits.maxFailures) {
      state.lockedUntil = at + limits.lockoutMs;
      state.failures = [];
      locked = true;
    }
    this.keys.delete(key);
    this.keys.set(key, state);
    while (this.keys.size > MAX_KEYS) {
      const oldest = this.keys.keys().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
    this.globalFailures = [...this.prune(this.globalFailures, limits.windowMs, at), at];
    const excess = this.globalFailures.length - limits.globalMaxFailures;
    if (excess < 0) return { locked, globalDelaySeconds: null };
    // 2^excess, without overflowing for a very long run of failures
    const delayMs = Math.min(limits.lockoutMs, limits.globalDelayMs * 2 ** Math.min(excess, 40));
    this.globalWaitUntil = Math.max(this.globalWaitUntil, at + delayMs);
    return { locked, globalDelaySeconds: Math.ceil(delayMs / 1000) };
  }

  /** A successful login: forget this key's failures. */
  recordSuccess(key: string): void {
    this.keys.delete(key);
  }
}

/**
 * The throttle key of a request: the last `X-Forwarded-For` entry (trimmed, at most 100 characters), else `direct`. The
 * last entry is the one the nearest hop added: `tailscale serve` replaces the header with the tailnet address it saw,
 * a proxy that appends puts the address it saw last, and Next fills in the socket's peer when the header is missing.
 * Entries in front of it are whatever the client sent. A client that talks to the web directly (no proxy) can still send
 * any value; the global limit covers that.
 */
export function throttleKey(forwardedFor: string | null): string {
  const last = (forwardedFor ?? "").split(",").at(-1)?.trim() ?? "";
  return last === "" ? "direct" : last.slice(0, 100);
}
