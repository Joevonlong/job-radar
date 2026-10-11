import type { ChannelHealth, CircuitState } from "@/lib/db/repos/channels";

import type { ChannelErrorCode } from "./types";

/** Persisted breaker state of one channel (columns of the `channels` table). */
export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  /** While `open`: when one probe run is allowed again. */
  openUntil: Date | null;
  lastErrorCode: string | null;
  lastSuccessAt: Date | null;
}

export interface CircuitConfig {
  /** Consecutive failed runs that open the circuit. */
  failures: number;
  cooldownMs: number;
}

export const CLOSED_CIRCUIT: CircuitSnapshot = {
  state: "closed",
  consecutiveFailures: 0,
  openUntil: null,
  lastErrorCode: null,
  lastSuccessAt: null,
};

/** `open` becomes `half_open` once the cooldown has passed: the next run is a probe. */
export function effectiveState(snapshot: CircuitSnapshot, now: Date): CircuitState {
  if (snapshot.state === "open" && snapshot.openUntil !== null && snapshot.openUntil.getTime() <= now.getTime()) {
    return "half_open";
  }
  return snapshot.state;
}

/** Runs are allowed while closed, and as a single probe while half-open. */
export function isCallAllowed(snapshot: CircuitSnapshot, now: Date): boolean {
  return effectiveState(snapshot, now) !== "open";
}

/** A successful run closes the circuit and clears the failure streak. */
export function afterSuccess(snapshot: CircuitSnapshot, now: Date): CircuitSnapshot {
  return { ...snapshot, state: "closed", consecutiveFailures: 0, openUntil: null, lastSuccessAt: now };
}

/**
 * A failed run extends the streak. The circuit opens when the streak reaches `config.failures`, or
 * immediately when a half-open probe fails or the failure `trips` the circuit on its own (a used-up
 * provider quota). (Budget exhaustion is not a failure: callers skip this.)
 */
export function afterFailure(
  snapshot: CircuitSnapshot,
  now: Date,
  code: ChannelErrorCode,
  config: CircuitConfig,
  options: { trips?: boolean } = {},
): CircuitSnapshot {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;
  const probeFailed = effectiveState(snapshot, now) === "half_open";
  const opens = probeFailed || options.trips === true || consecutiveFailures >= config.failures;
  return {
    ...snapshot,
    state: opens ? "open" : snapshot.state,
    consecutiveFailures,
    openUntil: opens ? new Date(now.getTime() + config.cooldownMs) : snapshot.openUntil,
    lastErrorCode: code,
  };
}

export function healthOf(snapshot: CircuitSnapshot, now: Date): ChannelHealth {
  if (effectiveState(snapshot, now) !== "closed") return "down";
  if (snapshot.consecutiveFailures > 0) return "degraded";
  return snapshot.lastSuccessAt === null ? "unknown" : "healthy";
}

export interface CircuitStore {
  loadCircuit(channelId: string): Promise<CircuitSnapshot>;
  saveCircuit(channelId: string, snapshot: CircuitSnapshot, health: ChannelHealth): Promise<void>;
}

export interface CircuitCheck {
  allowed: boolean;
  state: CircuitState;
  openUntil: Date | null;
}

/** Applies the transitions above to persisted state, caching snapshots for the lifetime of one cycle. */
export class CircuitBreaker {
  private readonly cache = new Map<string, CircuitSnapshot>();

  constructor(
    private readonly store: CircuitStore,
    private readonly config: () => CircuitConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async snapshot(channelId: string): Promise<CircuitSnapshot> {
    const cached = this.cache.get(channelId);
    if (cached) return cached;
    const loaded = await this.store.loadCircuit(channelId);
    this.cache.set(channelId, loaded);
    return loaded;
  }

  private async commit(channelId: string, next: CircuitSnapshot): Promise<void> {
    this.cache.set(channelId, next);
    await this.store.saveCircuit(channelId, next, healthOf(next, this.now()));
  }

  /** May this channel run now? Moves `open` → `half_open` (persisted) when the cooldown is over. */
  async check(channelId: string): Promise<CircuitCheck> {
    const now = this.now();
    let snap = await this.snapshot(channelId);
    const state = effectiveState(snap, now);
    if (state === "half_open" && snap.state === "open") {
      snap = { ...snap, state: "half_open" };
      await this.commit(channelId, snap);
    }
    return { allowed: state !== "open", state, openUntil: snap.openUntil };
  }

  async recordSuccess(channelId: string): Promise<void> {
    await this.commit(channelId, afterSuccess(await this.snapshot(channelId), this.now()));
  }

  async recordFailure(channelId: string, code: ChannelErrorCode, options: { trips?: boolean } = {}): Promise<void> {
    await this.commit(channelId, afterFailure(await this.snapshot(channelId), this.now(), code, this.config(), options));
  }
}
