import { isAbortError, toChannelError, ChannelError, InfrastructureError } from "./errors";
import type { ChannelFamily } from "./types";

/** A family whose channels are tried in order, one serving each query (LinkedIn). */
export interface CascadeSpec {
  family: ChannelFamily;
  /** Channel ids, best first. */
  order: readonly string[];
}

export type UnavailableReason = "not_registered" | "disabled" | "not_configured" | "budget_exceeded" | "circuit_open";

export interface CascadeDeps {
  /** null = usable now; otherwise why not. May be async (circuit state lives in the database). */
  availability(channelId: string): Promise<UnavailableReason | null> | UnavailableReason | null;
}

export interface FailedAttempt {
  channelId: string;
  error: ChannelError;
}

export type ServeOutcome<T> =
  /** A channel served the query. `attempts` are earlier channels that failed first. */
  | { status: "served"; channelId: string; value: T; attempts: FailedAttempt[] }
  /** The chosen channel failed with a retryable error: the query is not handed to the next channel. */
  | { status: "failed"; channelId: string; error: ChannelError; attempts: FailedAttempt[] }
  /** No channel could take the query. `reasons` says why for each channel in the order. */
  | { status: "skipped"; reasons: Record<string, string>; attempts: FailedAttempt[] };

/**
 * Picks, per query, the first usable channel of a family: enabled, within budget, circuit not open,
 * and not already given up on this cycle. A channel that fails with a budget error or a
 * non-retryable error (blocked, auth expired, parse, unknown) is unusable for the rest of the cycle
 * and the same query goes to the next channel. A retryable failure (any retries allowed by the channel
 * are already exhausted by `ctx.http`) fails the query; repeated ones are handled by the circuit breaker, which makes the
 * channel unavailable for later queries and cycles.
 *
 * One instance per cycle (it remembers which channels failed).
 */
export class CascadeController {
  private readonly unusable = new Map<string, string>();

  constructor(
    readonly spec: CascadeSpec,
    private readonly deps: CascadeDeps,
  ) {}

  /** Channels given up on during this cycle, with the error code that did it. */
  unusableChannels(): ReadonlyMap<string, string> {
    return this.unusable;
  }

  /** The first usable channel id for the next query, or per-channel reasons when there is none. */
  async pick(eligible?: (id: string) => boolean): Promise<{ channelId: string } | { reasons: Record<string, string> }> {
    const reasons: Record<string, string> = {};
    for (const id of this.spec.order) {
      if (eligible && !eligible(id)) continue;
      const failed = this.unusable.get(id);
      if (failed !== undefined) {
        reasons[id] = `failed_this_cycle:${failed}`;
        continue;
      }
      const reason = await this.deps.availability(id);
      if (reason === null) return { channelId: id };
      reasons[id] = reason;
    }
    return { reasons };
  }

  /**
   * Run `attempt` against the first usable channel, falling through on budget / non-retryable
   * errors. `attempt` should throw (a ChannelError, or anything: it is classified) when it fails.
   * Cancellation and infrastructure errors propagate.
   */
  async serve<T>(attempt: (channelId: string) => Promise<T>, eligible?: (id: string) => boolean): Promise<ServeOutcome<T>> {
    const attempts: FailedAttempt[] = [];
    for (;;) {
      const picked = await this.pick(eligible);
      if ("reasons" in picked) return { status: "skipped", reasons: picked.reasons, attempts };
      try {
        const value = await attempt(picked.channelId);
        return { status: "served", channelId: picked.channelId, value, attempts };
      } catch (error) {
        if (isAbortError(error) || error instanceof InfrastructureError) throw error;
        const channelError = toChannelError(error);
        if (channelError.code === "budget_exceeded" || !channelError.retryable) {
          this.unusable.set(picked.channelId, channelError.code);
          attempts.push({ channelId: picked.channelId, error: channelError });
          continue;
        }
        return { status: "failed", channelId: picked.channelId, error: channelError, attempts };
      }
    }
  }
}
