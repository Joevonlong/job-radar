/**
 * Job Radar's own AI usage cap for the subscription CLIs (ai.yaml `quota_guard`). It counts only the calls Job Radar made
 * itself (`ai_usage`, failed calls included), never the account's real remaining quota: the user's own use, other machines
 * and the web apps are invisible to it, so it can only trigger later than the real limit, never earlier.
 *
 * Two caps per provider: a rolling window (`hard_requests` calls within `window_hours`) that pauses the provider for every
 * task, and a per-cycle cap (`cycle_request_cap`) that only stops the rest of an unattended cycle. The window state is kept
 * in `runtime_state` (`ai_quota:<id>`) for the hysteresis and for the alerts (`notifiedLevel`); the router writes only the
 * window fields and the notify step only `notifiedLevel` (each a JSON merge), so neither clobbers the other from a stale
 * read. The per-cycle cap is counted fresh from `ai_usage` every time (main and late phase, runner and ai-worker all see
 * the same rows).
 */
import { z } from "zod";

import type { AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { countAiUsageSince, listAiUsageTimesSince } from "@/lib/db/repos/ai-usage";
import { getRuntimeState, listRuntimeState, mergeRuntimeState } from "@/lib/db/repos/runtime-state";

import { isCoolingDown, type ProviderHealth } from "./health";
import type { AiUsageEntry } from "./usage";
import { AI_PROVIDER_IDS, type AiProviderId } from "./types";

/** The providers the guard watches: the two subscription CLIs (the API providers have their monthly budget). */
export const QUOTA_GUARDED_PROVIDERS = ["codex-cli", "claude-cli"] as const satisfies readonly AiProviderId[];
export type QuotaGuardedProvider = (typeof QUOTA_GUARDED_PROVIDERS)[number];

const POLICY_KEY = { "codex-cli": "codex_cli", "claude-cli": "claude_cli" } as const satisfies Record<QuotaGuardedProvider, string>;

export function isQuotaGuarded(provider: AiProviderId): provider is QuotaGuardedProvider {
  return (QUOTA_GUARDED_PROVIDERS as readonly string[]).includes(provider);
}

export const QUOTA_LEVELS = ["ok", "hard"] as const;
export type QuotaLevel = (typeof QUOTA_LEVELS)[number];

/** Why a provider is held back: the window cap, this cycle's cap, or a real limit the provider reported (the cooldown). */
export const QUOTA_REASONS = ["window", "cycle_cap", "error"] as const;
export type QuotaReason = (typeof QUOTA_REASONS)[number];

/** Who asks: an unattended cycle, or the user (a button, a control request), which the per-cycle cap never holds back. */
export type AiRequestOrigin = "cycle" | "control";

/** The guard settings of one provider plus the shared ones, as `evaluateQuota` needs them. */
export interface QuotaPolicy {
  provider: QuotaGuardedProvider;
  windowHours: number;
  /** 0 = no window cap. */
  hardRequests: number;
  /** 0 = no cycle cap. */
  cycleRequestCap: number;
  resumeRatio: number;
  /** `cooldown.default_minutes` / `max_minutes`: the estimate when no resume time can be computed, and its ceiling. */
  defaultMinutes: number;
  maxMinutes: number;
}

/** The policy of `provider` from ai.yaml; null when the guard is off. */
export function quotaPolicy(config: Pick<AiConfig, "quota_guard" | "cooldown">, provider: QuotaGuardedProvider): QuotaPolicy | null {
  const guard = config.quota_guard;
  if (!guard.enabled) return null;
  const caps = guard.providers[POLICY_KEY[provider]];
  return {
    provider,
    windowHours: caps.window_hours,
    hardRequests: caps.hard_requests,
    cycleRequestCap: caps.cycle_request_cap,
    resumeRatio: guard.resume_ratio,
    defaultMinutes: config.cooldown.default_minutes,
    maxMinutes: config.cooldown.max_minutes,
  };
}

// ---------------------------------------------------------------- stored state

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "not a date")
  .transform((value) => new Date(value));

/** `runtime_state` `ai_quota:<id>`: the window state and the level the last alert was sent for. */
const quotaStateSchema = z.object({
  level: z.enum(QUOTA_LEVELS),
  /** Only `window` is stored here; an error cooldown lives in `ai_provider:<id>` (health). */
  reason: z.enum(["window"]).nullable(),
  since: isoDate.nullable(),
  resumeAt: isoDate.nullable(),
  /** The `hard_requests` that caused the window cap (null while `ok`): the hysteresis holds only while the cap is unchanged. */
  hardRequests: z.number().int().nonnegative().nullable().default(null),
  /** The level the last quota alert was sent for (null = none yet); an alert is due when the effective level differs. */
  notifiedLevel: z.enum(QUOTA_LEVELS).nullable().default(null),
});

export interface QuotaState {
  level: QuotaLevel;
  reason: "window" | null;
  since: Date | null;
  resumeAt: Date | null;
  /** The window cap in force when the provider was paused (null while `ok`). */
  hardRequests: number | null;
  notifiedLevel: QuotaLevel | null;
}

export const QUOTA_STATE_KEY_PREFIX = "ai_quota:";

export function quotaStateKey(provider: AiProviderId): string {
  return `${QUOTA_STATE_KEY_PREFIX}${provider}`;
}

/** A stored state; anything that does not validate reads as "no state" (it is overwritten on the next evaluation). */
export function parseQuotaState(value: unknown): QuotaState | null {
  const parsed = quotaStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function serializeQuotaState(state: QuotaState): Record<string, unknown> {
  return { ...serializeQuotaWindow(state), notifiedLevel: state.notifiedLevel };
}

/** The router's part of the stored state (everything but `notifiedLevel`, which belongs to the alerts). */
export function serializeQuotaWindow(state: Omit<QuotaState, "notifiedLevel">): Record<string, unknown> {
  return {
    level: state.level,
    reason: state.reason,
    since: state.since?.toISOString() ?? null,
    resumeAt: state.resumeAt?.toISOString() ?? null,
    hardRequests: state.hardRequests,
  };
}

// ---------------------------------------------------------------- evaluation

export interface QuotaUsageRow {
  provider: string;
  at: Date;
}

export interface QuotaEvaluation {
  level: QuotaLevel;
  /** `window` while the window cap holds; null when `ok`. */
  reason: "window" | null;
  /** When the provider is expected to be usable again (only while `hard`); never later than `maxMinutes` from now. */
  resumeAt: Date | null;
  /** Calls of this provider inside the window ending now. */
  windowRequests: number;
  /** The window cap this evaluation used (`policy.hardRequests`; 0 = off). */
  hardRequests: number;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Pure: the window state of `policy.provider` from its calls. `hard` once the window holds `hard_requests` calls; after
 * a window cap it stays `hard` until the count is below `resume_ratio × hard_requests` (hysteresis) — but only while the
 * cap is the one that caused the pause: after a change of `hard_requests` the window is judged afresh. `resumeAt` is the
 * moment enough of the oldest calls have slid out of the window; when it cannot be computed, now + `defaultMinutes`;
 * never later than now + `maxMinutes`. `hard_requests: 0` = the window cap is off (always `ok`).
 */
export function evaluateQuota(rows: readonly QuotaUsageRow[], policy: QuotaPolicy, now: Date, previous: QuotaState | null): QuotaEvaluation {
  const windowMs = policy.windowHours * HOUR_MS;
  const start = now.getTime() - windowMs;
  const times = rows
    .filter((row) => row.provider === policy.provider && row.at.getTime() > start && row.at.getTime() <= now.getTime())
    .map((row) => row.at.getTime())
    .sort((a, b) => a - b);
  const windowRequests = times.length;
  const hardRequests = policy.hardRequests;
  if (hardRequests <= 0) return { level: "ok", reason: null, resumeAt: null, windowRequests, hardRequests };

  const resumeLine = policy.resumeRatio * hardRequests;
  // a pause caused by another cap (the user raised or lowered it since) does not carry over
  const wasHard = previous?.level === "hard" && previous.reason === "window" && previous.hardRequests === hardRequests;
  const hard = wasHard ? windowRequests >= resumeLine : windowRequests >= hardRequests;
  if (!hard) return { level: "ok", reason: null, resumeAt: null, windowRequests, hardRequests };

  // Below the line means at most `allowed` calls; the k-th oldest call has to leave the window for that.
  const allowed = Math.ceil(resumeLine) - 1;
  const mustLeave = windowRequests - allowed;
  const ceiling = now.getTime() + policy.maxMinutes * MINUTE_MS;
  const leaving = mustLeave >= 1 ? times[mustLeave - 1] : undefined;
  const estimate = leaving !== undefined ? leaving + windowMs : now.getTime() + policy.defaultMinutes * MINUTE_MS;
  return { level: "hard", reason: "window", resumeAt: new Date(Math.min(Math.max(estimate, now.getTime()), ceiling)), windowRequests, hardRequests };
}

/** The state to store after an evaluation: `since` marks a level change; `notifiedLevel` is the alerts' business and is kept. */
export function nextQuotaState(previous: QuotaState | null, evaluation: QuotaEvaluation, now: Date): QuotaState {
  const changed = previous === null || previous.level !== evaluation.level;
  return {
    level: evaluation.level,
    reason: evaluation.reason,
    since: changed ? now : previous.since,
    resumeAt: evaluation.resumeAt,
    hardRequests: evaluation.level === "hard" ? evaluation.hardRequests : null,
    notifiedLevel: previous?.notifiedLevel ?? null,
  };
}

/** Whether storing `next` would change the router's part of the state (avoids a write per routed call). */
export function quotaStateChanged(previous: QuotaState | null, next: QuotaState): boolean {
  if (previous === null) return true;
  return (
    previous.level !== next.level ||
    previous.reason !== next.reason ||
    previous.hardRequests !== next.hardRequests ||
    (previous.resumeAt?.getTime() ?? null) !== (next.resumeAt?.getTime() ?? null)
  );
}

/** What the pages, the doctor and the alerts show: the window state merged with a running error cooldown (the later resume time wins). */
export interface QuotaStatus {
  provider: QuotaGuardedProvider;
  level: QuotaLevel;
  reason: QuotaReason | null;
  resumeAt: Date | null;
  windowRequests: number;
  windowHours: number;
  hardRequests: number;
  cycleRequestCap: number;
  notifiedLevel: QuotaLevel | null;
}

/** Pure: merge the window evaluation with the provider's health (an error cooldown counts as `hard`, reason `error`). */
export function effectiveQuota(
  policy: QuotaPolicy,
  evaluation: QuotaEvaluation,
  health: ProviderHealth | null | undefined,
  now: Date,
  stored: QuotaState | null,
): QuotaStatus {
  const cooling = health && isCoolingDown(health, now) ? health.coolingUntil : null;
  const base = {
    provider: policy.provider,
    windowRequests: evaluation.windowRequests,
    windowHours: policy.windowHours,
    hardRequests: policy.hardRequests,
    cycleRequestCap: policy.cycleRequestCap,
    notifiedLevel: stored?.notifiedLevel ?? null,
  };
  if (evaluation.level === "hard") {
    const resumeAt = cooling && evaluation.resumeAt && cooling > evaluation.resumeAt ? cooling : evaluation.resumeAt;
    return { ...base, level: "hard", reason: "window", resumeAt };
  }
  if (cooling) return { ...base, level: "hard", reason: "error", resumeAt: cooling };
  return { ...base, level: "ok", reason: null, resumeAt: null };
}

// ---------------------------------------------------------------- choosing the defaults

/** What `suggestQuotaCaps` needs of the read-only usage statistics (`aiUsageStats`). */
export interface QuotaHistory {
  provider: string;
  firstAt: Date | null;
  lastAt: Date | null;
  windowMax: number | null;
  cycleMax: number | null;
  /** Cycles with at least one call of the provider. */
  cycles: number;
}

export interface QuotaCapSuggestion {
  provider: string;
  hardRequests: number;
  cycleRequestCap: number;
  /** `history`: 1.5 x the observed maxima; `fallback`: too little history (under `minDays` days or `minCycles` cycles). */
  basis: "history" | "fallback";
}

/**
 * Pure: the default caps the usage history calls for: 1.5 x the most calls seen in one window / one cycle (rounded up).
 * With too little history the fallback: codex-cli cycle cap = 2 x `per_cycle_limit` and window cap = 2 x that,
 * claude-cli 10 / 20.
 */
export function suggestQuotaCaps(history: QuotaHistory, options: { perCycleLimit: number; minDays: number; minCycles: number }): QuotaCapSuggestion {
  const spanDays = history.firstAt && history.lastAt ? (history.lastAt.getTime() - history.firstAt.getTime()) / (24 * HOUR_MS) : 0;
  if (spanDays >= options.minDays && history.cycles >= options.minCycles && history.windowMax !== null && history.cycleMax !== null) {
    return { provider: history.provider, hardRequests: Math.ceil(history.windowMax * 1.5), cycleRequestCap: Math.ceil(history.cycleMax * 1.5), basis: "history" };
  }
  if (history.provider === "codex-cli") {
    const cycle = options.perCycleLimit * 2;
    return { provider: history.provider, hardRequests: cycle * 2, cycleRequestCap: cycle, basis: "fallback" };
  }
  return { provider: history.provider, hardRequests: 20, cycleRequestCap: 10, basis: "fallback" };
}

// ---------------------------------------------------------------- store

/** Where the guard reads the calls and keeps its state. The router takes one; null / absent = no guard. */
export interface AiQuotaStore {
  /** The calls of `provider` since `since`. */
  usageSince(provider: AiProviderId, since: Date): Promise<QuotaUsageRow[]>;
  countSince(provider: AiProviderId, since: Date): Promise<number>;
  getState(provider: AiProviderId): Promise<QuotaState | null>;
  /** Stores the window fields only; the stored `notifiedLevel` is kept (a merge, not a replace). */
  setState(provider: AiProviderId, state: QuotaState): Promise<void>;
  /** Stores `notifiedLevel` only; the window fields are kept (without a state: a window `ok` one is created). */
  setNotifiedLevel(provider: AiProviderId, level: QuotaLevel, now: Date): Promise<void>;
}

/** The state written when the alerts record a level before the router has stored anything. */
function freshQuotaState(now: Date, notifiedLevel: QuotaLevel | null): QuotaState {
  return { level: "ok", reason: null, since: now, resumeAt: null, hardRequests: null, notifiedLevel };
}

export function createDbQuotaStore(db: Db): AiQuotaStore {
  return {
    usageSince: async (provider, since) => (await listAiUsageTimesSince(db, { provider, since })).map((at) => ({ provider, at })),
    countSince: (provider, since) => countAiUsageSince(db, { provider, since }),
    getState: async (provider) => parseQuotaState((await getRuntimeState(db, quotaStateKey(provider)))?.value),
    setState: (provider, state) => mergeRuntimeState(db, quotaStateKey(provider), { insert: serializeQuotaState({ ...state, notifiedLevel: null }), patch: serializeQuotaWindow(state) }),
    setNotifiedLevel: (provider, level, now) =>
      mergeRuntimeState(db, quotaStateKey(provider), { insert: serializeQuotaState(freshQuotaState(now, level)), patch: { notifiedLevel: level } }),
  };
}

/** In memory (tests): the calls come from `entries` (e.g. a memory usage store's), the states from a map. */
export function createMemoryQuotaStore(entries: readonly Pick<AiUsageEntry, "provider" | "at">[] = []): AiQuotaStore & { states: Map<AiProviderId, QuotaState> } {
  const states = new Map<AiProviderId, QuotaState>();
  const since = (provider: AiProviderId, from: Date) => entries.filter((e) => e.provider === provider && e.at.getTime() >= from.getTime());
  return {
    states,
    usageSince: async (provider, from) => since(provider, from).map((e) => ({ provider: e.provider, at: e.at })),
    countSince: async (provider, from) => since(provider, from).length,
    getState: async (provider) => states.get(provider) ?? null,
    setState: async (provider, state) => {
      states.set(provider, { ...state, notifiedLevel: states.get(provider)?.notifiedLevel ?? null });
    },
    setNotifiedLevel: async (provider, level, now) => {
      states.set(provider, { ...(states.get(provider) ?? freshQuotaState(now, null)), notifiedLevel: level });
    },
  };
}

/** Every stored quota state (unreadable rows are left out). */
export async function listQuotaStates(db: Db): Promise<Map<AiProviderId, QuotaState>> {
  const out = new Map<AiProviderId, QuotaState>();
  for (const row of await listRuntimeState(db, QUOTA_STATE_KEY_PREFIX)) {
    const id = AI_PROVIDER_IDS.find((p) => quotaStateKey(p) === row.key);
    const state = id ? parseQuotaState(row.value) : null;
    if (id && state) out.set(id, state);
  }
  return out;
}

/**
 * Remember that the alerts have dealt with `level` (sent, or dropped by the anti-flap window), so the same state is not
 * announced again. Only `notifiedLevel` is written: the window fields the router keeps are never overwritten from here.
 */
export async function recordQuotaNotified(store: AiQuotaStore, provider: AiProviderId, level: QuotaLevel, now: Date): Promise<void> {
  const stored = await store.getState(provider);
  if (stored?.notifiedLevel === level) return;
  await store.setNotifiedLevel(provider, level, now);
}

/**
 * The current status of every guarded provider (read only: nothing is stored). Empty when the guard is off. A provider
 * whose calls cannot be read counts as `ok` (fail-open), like in the router.
 */
export async function readQuotaStatuses(
  store: AiQuotaStore,
  config: Pick<AiConfig, "quota_guard" | "cooldown">,
  health: ReadonlyMap<AiProviderId, ProviderHealth>,
  now: Date,
): Promise<Map<QuotaGuardedProvider, QuotaStatus>> {
  const out = new Map<QuotaGuardedProvider, QuotaStatus>();
  for (const provider of QUOTA_GUARDED_PROVIDERS) {
    const policy = quotaPolicy(config, provider);
    if (!policy) continue;
    let stored: QuotaState | null = null;
    let evaluation: QuotaEvaluation = { level: "ok", reason: null, resumeAt: null, windowRequests: 0, hardRequests: policy.hardRequests };
    try {
      stored = await store.getState(provider);
      const rows = await store.usageSince(provider, new Date(now.getTime() - policy.windowHours * HOUR_MS));
      evaluation = evaluateQuota(rows, policy, now, stored);
    } catch {
      // fail-open: no numbers, no cap
    }
    out.set(provider, effectiveQuota(policy, evaluation, health.get(provider), now, stored));
  }
  return out;
}
