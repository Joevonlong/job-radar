import type { Db } from "@/lib/db/client";
import { getRuntimeState, listRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { AI_PROVIDER_IDS, type AiProviderId } from "./types";

/**
 * Cross-process provider health: when a provider last worked, last failed, until when it is cooling down
 * after a quota / session-limit / rate-limit error, and how many requests it served today. The router of every
 * process (runner, ai-worker) reads and writes the same rows (`runtime_state`, key `ai_provider:<id>`), so one
 * "You've hit your session limit" is enough to make all of them skip the provider until it resets.
 */
export interface ProviderHealth {
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  /** Skip the provider until then; null / past = not cooling down. */
  coolingUntil: Date | null;
  /** The day `requestsToday` counts (`YYYY-MM-DD` in the configured time zone). */
  day: string | null;
  requestsToday: number;
}

export const EMPTY_HEALTH: ProviderHealth = { lastSuccessAt: null, lastErrorAt: null, lastErrorKind: null, lastErrorMessage: null, coolingUntil: null, day: null, requestsToday: 0 };

export interface AiHealthStore {
  get(provider: AiProviderId): Promise<ProviderHealth>;
  /** Count one request against today's cap (`day` rolls the counter over). */
  noteRequest(provider: AiProviderId, at: Date, day: string): Promise<void>;
  noteSuccess(provider: AiProviderId, at: Date): Promise<void>;
  noteFailure(provider: AiProviderId, at: Date, failure: { kind: string; message: string; coolingUntil: Date | null }): Promise<void>;
}

export const HEALTH_KEY_PREFIX = "ai_provider:";

const asDate = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Parse a stored row; anything unexpected reads as "no information". */
export function parseHealth(value: unknown): ProviderHealth {
  if (typeof value !== "object" || value === null) return EMPTY_HEALTH;
  const v = value as Record<string, unknown>;
  return {
    lastSuccessAt: asDate(v.lastSuccessAt),
    lastErrorAt: asDate(v.lastErrorAt),
    lastErrorKind: asString(v.lastErrorKind),
    lastErrorMessage: asString(v.lastErrorMessage),
    coolingUntil: asDate(v.coolingUntil),
    day: asString(v.day),
    requestsToday: typeof v.requestsToday === "number" && Number.isFinite(v.requestsToday) ? v.requestsToday : 0,
  };
}

const serialize = (health: ProviderHealth): Record<string, unknown> => ({
  lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
  lastErrorAt: health.lastErrorAt?.toISOString() ?? null,
  lastErrorKind: health.lastErrorKind,
  lastErrorMessage: health.lastErrorMessage,
  coolingUntil: health.coolingUntil?.toISOString() ?? null,
  day: health.day,
  requestsToday: health.requestsToday,
});

/** Requests counted for `day`: yesterday's counter reads as 0. */
export function requestsOn(health: ProviderHealth, day: string): number {
  return health.day === day ? health.requestsToday : 0;
}

export function isCoolingDown(health: ProviderHealth, now: Date): boolean {
  return health.coolingUntil !== null && health.coolingUntil.getTime() > now.getTime();
}

/** Shared update logic of both stores. */
function applyEvent(health: ProviderHealth, event: { type: "request"; day: string } | { type: "success"; at: Date } | { type: "failure"; at: Date; kind: string; message: string; coolingUntil: Date | null }): ProviderHealth {
  switch (event.type) {
    case "request":
      return { ...health, day: event.day, requestsToday: requestsOn(health, event.day) + 1 };
    case "success":
      // A success also ends a cooldown that has not expired yet (the limit was lifted early).
      return { ...health, lastSuccessAt: event.at, coolingUntil: null };
    case "failure":
      return {
        ...health,
        lastErrorAt: event.at,
        lastErrorKind: event.kind,
        lastErrorMessage: event.message,
        // Never shorten a cooldown another process already set.
        coolingUntil: event.coolingUntil && (!health.coolingUntil || event.coolingUntil > health.coolingUntil) ? event.coolingUntil : health.coolingUntil,
      };
  }
}

export function createDbHealthStore(db: Db): AiHealthStore {
  const key = (provider: AiProviderId) => `${HEALTH_KEY_PREFIX}${provider}`;
  const get = async (provider: AiProviderId): Promise<ProviderHealth> => parseHealth((await getRuntimeState(db, key(provider)))?.value);
  const update = async (provider: AiProviderId, event: Parameters<typeof applyEvent>[1]): Promise<void> => {
    await setRuntimeState(db, key(provider), serialize(applyEvent(await get(provider), event)));
  };
  return {
    get,
    noteRequest: (provider, _at, day) => update(provider, { type: "request", day }),
    noteSuccess: (provider, at) => update(provider, { type: "success", at }),
    noteFailure: (provider, at, failure) => update(provider, { type: "failure", at, ...failure }),
  };
}

export function createMemoryHealthStore(): AiHealthStore & { rows: Map<AiProviderId, ProviderHealth> } {
  const rows = new Map<AiProviderId, ProviderHealth>();
  const get = async (provider: AiProviderId): Promise<ProviderHealth> => rows.get(provider) ?? EMPTY_HEALTH;
  const update = async (provider: AiProviderId, event: Parameters<typeof applyEvent>[1]): Promise<void> => {
    rows.set(provider, applyEvent(await get(provider), event));
  };
  return {
    rows,
    get,
    noteRequest: (provider, _at, day) => update(provider, { type: "request", day }),
    noteSuccess: (provider, at) => update(provider, { type: "success", at }),
    noteFailure: (provider, at, failure) => update(provider, { type: "failure", at, ...failure }),
  };
}

/** Every provider's stored health (providers without a row are absent). */
export async function listProviderHealth(db: Db): Promise<Map<AiProviderId, ProviderHealth>> {
  const out = new Map<AiProviderId, ProviderHealth>();
  for (const row of await listRuntimeState(db, HEALTH_KEY_PREFIX)) {
    const id = AI_PROVIDER_IDS.find((p) => `${HEALTH_KEY_PREFIX}${p}` === row.key);
    if (id) out.set(id, parseHealth(row.value));
  }
  return out;
}

/** "A day" for the request cap: `YYYY-MM-DD` in the configured time zone. */
export function healthDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// ------------------------------------------------------------------ quota errors

const UNIT_MS: Record<string, number> = { day: 86_400_000, d: 86_400_000, hour: 3_600_000, hr: 3_600_000, h: 3_600_000, minute: 60_000, min: 60_000, m: 60_000, second: 1000, sec: 1000, s: 1000 };

/**
 * When the limit named in `message` lifts, if the message says so: "try again in 3 hours 12 minutes", "resets 5pm",
 * "resets at 17:40", "try again at 5:40 PM", "limit reached|1760000000". Clock times are read in the time zone of this
 * process (the ai-worker runs on the user's Mac); a zone named in brackets is ignored. null = not stated.
 */
export function parseResetTime(message: string, now: Date): Date | null {
  const epoch = /limit reached\|(\d{10})\b/i.exec(message);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000);

  const relative = /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(message);
  if (relative?.[1]) {
    let ms = 0;
    for (const part of relative[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const unit = (part[2] ?? "").toLowerCase().replace(/s$/, "");
      ms += Number(part[1]) * (UNIT_MS[unit] ?? 0);
    }
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  const clock = /(?:try again|resets?|reset)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  return null;
}

/** Until when a provider that just reported a quota error is skipped: the stated reset time, else `defaultMinutes`; never beyond `maxMinutes`. */
export function cooldownUntil(message: string, now: Date, policy: { default_minutes: number; max_minutes: number }): Date {
  const cap = now.getTime() + policy.max_minutes * 60_000;
  const parsed = parseResetTime(message, now);
  const until = parsed && parsed.getTime() > now.getTime() ? parsed.getTime() : now.getTime() + policy.default_minutes * 60_000;
  return new Date(Math.min(until, cap));
}
