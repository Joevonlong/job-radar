import type { Db } from "@/lib/db/client";
import { getChannelRows, saveCircuitState } from "@/lib/db/repos/channels";
import { getRawPayloadsByExternalId } from "@/lib/db/repos/raw-postings";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { CLOSED_CIRCUIT, healthOf } from "../../circuit";
import { AUTH_FLAG_KEY, readAuthFlag, type AuthFlag } from "./auth-state";
import { LINKEDIN_SESSION_ID, LINKEDIN_SESSION_RECOMMENDED_ID } from "./contract";

/** What the session channels keep between runs (all of it small: counters, a flag, a timestamp, and payloads to re-deliver). */
export interface SessionStore {
  /** LinkedIn pages loaded on `day` (`YYYY-MM-DD`) by all session channels. */
  requestsOn(day: string): Promise<number>;
  /** Count one more page load on `day`; returns the new total. Call it before the load, so a crash cannot undercount. */
  addRequest(day: string): Promise<number>;
  /** Postings these channels already hold, by job id: re-delivered as they are instead of opening their pages again. */
  storedPayloads(jobIds: readonly string[]): Promise<Map<string, unknown>>;
  loadAuthFlag(): Promise<AuthFlag | null>;
  saveAuthFlag(flag: AuthFlag): Promise<void>;
  /** When "recommended for you" was last read (the database clock); null before the first time. */
  lastRecommendedAt(): Promise<Date | null>;
  markRecommended(): Promise<void>;
}

const REQUESTS_PREFIX = "linkedin-session:requests:";
const RECOMMENDED_KEY = "linkedin-session:recommended:last_run";

function countOf(value: unknown): number {
  if (typeof value === "object" && value !== null && "count" in value && typeof value.count === "number" && Number.isFinite(value.count)) return Math.max(0, Math.floor(value.count));
  return 0;
}

/** The store behind the `runtime_state` and `raw_postings` tables. The runner holds the cycle lock, and the channels run one browser at a time, so read-modify-write of the counter is safe. */
export function createDbSessionStore(db: Db): SessionStore {
  return {
    async requestsOn(day) {
      return countOf((await getRuntimeState(db, `${REQUESTS_PREFIX}${day}`))?.value);
    },
    async addRequest(day) {
      const next = countOf((await getRuntimeState(db, `${REQUESTS_PREFIX}${day}`))?.value) + 1;
      await setRuntimeState(db, `${REQUESTS_PREFIX}${day}`, { count: next });
      return next;
    },
    storedPayloads: (jobIds) => getRawPayloadsByExternalId(db, { channelIds: [LINKEDIN_SESSION_ID, LINKEDIN_SESSION_RECOMMENDED_ID], externalIds: jobIds }),
    async loadAuthFlag() {
      return readAuthFlag((await getRuntimeState(db, AUTH_FLAG_KEY))?.value);
    },
    saveAuthFlag: (flag) => setRuntimeState(db, AUTH_FLAG_KEY, flag),
    async lastRecommendedAt() {
      return (await getRuntimeState(db, RECOMMENDED_KEY))?.updatedAt ?? null;
    },
    markRecommended: () => setRuntimeState(db, RECOMMENDED_KEY, { ok: true }),
  };
}

/** In-memory store: dry runs (nothing is written) and unit tests. */
export function createMemorySessionStore(seed: { requests?: Record<string, number>; payloads?: Record<string, unknown>; flag?: AuthFlag | null; recommendedAt?: Date | null } = {}): SessionStore & {
  requests: Map<string, number>;
  payloads: Map<string, unknown>;
  flag: AuthFlag | null;
  recommendedAt: Date | null;
} {
  const store = {
    requests: new Map(Object.entries(seed.requests ?? {})),
    payloads: new Map(Object.entries(seed.payloads ?? {})),
    flag: seed.flag ?? null,
    recommendedAt: seed.recommendedAt ?? null,
    async requestsOn(day: string) {
      return store.requests.get(day) ?? 0;
    },
    async addRequest(day: string) {
      const next = (store.requests.get(day) ?? 0) + 1;
      store.requests.set(day, next);
      return next;
    },
    async storedPayloads(jobIds: readonly string[]) {
      return new Map(jobIds.flatMap((id) => (store.payloads.has(id) ? [[id, store.payloads.get(id)] as const] : [])));
    },
    async loadAuthFlag() {
      return store.flag;
    },
    async saveAuthFlag(flag: AuthFlag) {
      store.flag = flag;
    },
    async lastRecommendedAt() {
      return store.recommendedAt;
    },
    async markRecommended() {
      store.recommendedAt = new Date();
    },
  };
  return store;
}

/**
 * After the user logged in again (`pnpm auth:linkedin`): mark the login valid and close the circuits the verification stop opened,
 * so the channels run in the next cycle instead of waiting out the cooldown. Returns the channels whose circuit was reset.
 */
export async function resetSessionAuth(db: Db, now: Date): Promise<string[]> {
  await setRuntimeState(db, AUTH_FLAG_KEY, { status: "valid", at: now.toISOString() } satisfies AuthFlag);
  const rows = await getChannelRows(db, [LINKEDIN_SESSION_ID, LINKEDIN_SESSION_RECOMMENDED_ID]);
  const reset: string[] = [];
  for (const row of rows) {
    if (row.circuitState === "closed" && row.consecutiveFailures === 0) continue;
    const closed = { ...CLOSED_CIRCUIT, lastSuccessAt: row.lastSuccessAt };
    await saveCircuitState(db, row.id, {
      circuitState: "closed",
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastErrorCode: row.lastErrorCode,
      lastSuccessAt: row.lastSuccessAt,
      health: healthOf(closed, now),
    });
    reset.push(row.id);
  }
  return reset;
}
