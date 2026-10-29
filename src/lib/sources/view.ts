/** View model of `/sources`: database rows + the config, folded into one card per channel. Pure; `load.ts` reads the data. */
import type { SearchQuery } from "@/lib/channels/types";
import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";
import { effectiveState } from "@/lib/channels/circuit";
import { CHANNEL_CONFIG_TABLE, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { healthDay, isCoolingDown, requestsOn, type ProviderHealth } from "@/lib/ai/health";
import { aiProviderState, type AiProviderState } from "@/lib/ai/provider-state";
import type { QuotaStatus } from "@/lib/ai/quota-guard";
import { AI_PROVIDER_IDS, type AiProviderId } from "@/lib/ai/types";
import { cliDefaultModel, findCatalogModel, type AiConfig, type ChannelsConfig, type ModelsConfig } from "@/lib/config";
import type { AiUsageRow, ChannelCycleStat, ChannelStateRow, CycleChannelRuns, LatestCycleRuns, MonthRunTotals, RecentRun } from "@/lib/db/queries/sources";
import type { MonthUsage } from "@/lib/db/repos/channels";
import type { LoginState } from "@/lib/channels/linkedin/session/auth-state";
import { computeHeartbeatAgeSeconds } from "@/lib/health";
import { missingChannelEnv } from "./required-env";
import type { AiWorkerStatus } from "@/lib/ops/ai-worker";

import { cascadeStartChannel, rotationStatus, rotationUnits, type RotationStatus } from "./rotation-status";

export type CircuitView = "closed" | "open" | "half_open";

/** Outcome of one channel in one cycle, as the health strip shows it. */
export type CycleOutcome = "ok" | "warn" | "fail";

/**
 * How a channel did in one cycle, from its runs: all runs failed = `fail`; some failed, ended partial or were interrupted = `warn`;
 * at least one succeeded and none failed = `ok`. No run, or only skipped ones (the cascade did not need it), = null:
 * nothing to judge. An interrupted run (the query failed after some pages, which were kept) is never "good": with no
 * answering run it is a `fail` next to a failed one, else a `warn`, since something did arrive.
 */
export function cycleOutcome(stat: ChannelCycleStat | null): CycleOutcome | null {
  if (stat === null || stat.runs === 0) return null;
  const good = stat.succeeded + stat.partial;
  if (stat.failed > 0 && good === 0) return "fail";
  if (stat.failed > 0 || stat.partial > 0 || stat.interrupted > 0) return "warn";
  if (stat.succeeded > 0) return "ok";
  return null;
}

/** What the channel card says in words (the light and the text come from this one value). */
export type ChannelStatus = "off" | "not_registered" | "missing_credentials" | "open" | "half_open" | "failing" | "degraded" | "ok" | "idle";

export interface ChannelHistory {
  /** Last `trend` cycles, oldest first: raw postings fetched; null where the channel had no run in the cycle. */
  fetched: (number | null)[];
  /** Last `health` cycles, oldest first. */
  outcomes: (CycleOutcome | null)[];
  /** The channel has a run in progress. */
  running: boolean;
  /** What the newest cycle brought (null: the channel did not take part in it). */
  latest: { fetched: number; newCount: number } | null;
  /** How many of the newest cycles in a row (cycles without a run are ignored) only had skipped runs: the cascade had nothing available, or the budget was used up. 0 = the newest run did something. */
  skippedStreak: number;
}

export interface UsageView {
  records: number;
  usd: number;
  /** `monthly_budget_usd` of the channel; 0 = it may not spend. */
  budgetUsd: number;
  /** Free records per month (Bright Data); 0 = none. */
  freeRecords: number;
  /** What the channel did this month, counted from its runs (the budget counters above only count what is billed). */
  activity: MonthRunTotals;
}

export interface SourceCard {
  /** Independent keyword units only; cascade members share the cascade card's status. */
  rotation?: RotationStatus;
  id: string;
  /** From the `channels` row; null while the runner never registered the channel. */
  family: string | null;
  /** The channel's kind (`paid`, `session`, `guest`, ...) from its row; null while the runner never registered it. */
  kind: string | null;
  /** The "test" button is offered (registered, and its kind is not in `sources.yaml: test_channel.excluded_kinds`). */
  testable: boolean;
  /** The channel has code and a row: the runner can run it. False = configured, not implemented yet. */
  registered: boolean;
  /** `enabled` in sources.yaml (false when the channel serves only other markets). */
  enabled: boolean;
  /** The channel serves only other markets (`markets` of sources.yaml): off, not a failure. */
  otherMarket: boolean;
  /** `markets` of sources.yaml; empty = every market. */
  markets: string[];
  /** The channel needs credentials that are not set (`brave` / `tavily` without their API key: it runs but does nothing; `jsearch` without `JSEARCH_API_KEY`: it sends no request; `linkedin-apify` without `APIFY_TOKEN` or an actor id, `linkedin-monid` / `linkedin-brightdata` without their keys: the cascade skips them). */
  notConfigured: boolean;
  /** Names of the environment variables this channel needs and lacks (names only; empty when none, or when the caller passed no environment). */
  missingEnv: string[];
  /** The LinkedIn session channels only: the state of the saved login ("未登录" / valid / expired); null for every other channel. */
  login: LoginState | null;
  circuit: { state: CircuitView; openUntil: Date | null; consecutiveFailures: number; lastErrorCode: string | null } | null;
  lastSuccessAt: Date | null;
  usage: UsageView;
  runs: RecentRun[];
  /** The channel's runs in the latest cycle; null when it had none. */
  latestCycleRuns: CycleChannelRuns | null;
  /** Per-cycle history from the real run records. */
  history: ChannelHistory;
  status: ChannelStatus;
  /** Set while the channel's newest cycles were all skipped (`history.skippedStreak` > 0): how many, and the error code of the latest skipped run. */
  skipped: { cycles: number; errorCode: string | null } | null;
}

export interface CascadeEntry {
  id: string;
  /** 1-based position in `linkedin.cascade`. */
  position: number;
  /** The quota the step spends from this month: free records, a paid budget, or none (no limit to run into). */
  quota: { kind: "free"; used: number; limit: number } | { kind: "paid"; used: number; limit: number } | { kind: "none" };
  enabled: boolean;
  /** The channel lacks its credentials (see `SourceCard.notConfigured`). */
  notConfigured: boolean;
  /** The saved login of a LinkedIn session channel (see `SourceCard.login`); null for the others. */
  login: LoginState | null;
  circuit: CircuitView | null;
  /** What the channel did in the latest cycle; null when it did not take part. */
  latest: CycleChannelRuns | null;
}

/** One AI provider's health: the switches in ai.yaml next to what the router last saw. */
export interface AiProviderView {
  id: AiProviderId;
  enabled: boolean;
  /** An API provider whose key is not set cannot be used (CLI providers are always "configured"). */
  configured: boolean;
  /** `daily_request_cap`; 0 = unlimited. */
  dailyCap: number;
  requestsToday: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  /** Set only while the cooldown is still running. */
  coolingUntil: Date | null;
  /** Set only while Job Radar's own usage cap (its rolling window) holds it back: when it is expected back. */
  guardedUntil: Date | null;
  /** Whether it can take a request now (shared with the settings dropdowns). */
  state: AiProviderState;
  /**
   * Job Radar's own usage cap of a subscription CLI (ai.yaml `quota_guard`): its calls in the rolling window against the
   * cap. Null for the API providers, when the cap is off or when it could not be read.
   */
  quota: AiProviderQuota | null;
  /** The default model of the provider now (from ai.yaml, named by models.yaml). */
  model: AiProviderModel;
}

export interface AiProviderQuota {
  level: "ok" | "hard";
  /** `window`: the rolling window is full; `error`: the provider reported a limit (the cooldown). */
  reason: "window" | "cycle_cap" | "error" | null;
  resumeAt: Date | null;
  windowRequests: number;
  /** 0 = the window cap is off. */
  hardRequests: number;
  windowHours: number;
}

/** `cliDefault`: codex without a model of its own; `deprecated` / `missing`: the catalog flags it; without a catalog nothing is flagged. */
export interface AiProviderModel {
  id: string | null;
  label: string | null;
  status: "ok" | "deprecated" | "missing" | "cliDefault";
}

const POLICY_KEY = { "claude-cli": "claude_cli", "codex-cli": "codex_cli", anthropic: "anthropic", deepseek: "deepseek", mimo: "mimo" } as const;

export interface SourcesView {
  maxBackfillHours: number;
  month: string;
  cards: SourceCard[];
  cascade: { rotation?: RotationStatus; entries: CascadeEntry[]; /** Channels that served at least one query in the latest cycle, in cascade order. */ servedBy: string[] };
  paid: { usedUsd: number; capUsd: number };
  /** Where a budget battery draws its red line, percent (`notify.yaml: alerts.budget_thresholds`, the lowest). */
  budgetAlertPercent: number;
  /** Cells of the health strip of a channel card (`ui.yaml: health_cycles`). */
  healthCycles: number;
  ai: {
    rows: AiUsageRow[];
    /** Estimated spend of the paid API providers this month. */
    apiSpendUsd: number;
    budgetUsd: number;
    totalCostUsd: number;
    /** Provider health, one row per provider. Empty when the config was not given. */
    providers: AiProviderView[];
  };
  latestCycle: LatestCycleRuns | null;
  runner: { lastHeartbeatAt: Date | null; ageSeconds: number | null; online: boolean; intervalSeconds: number };
  /** The host ai-worker: heartbeat, queued AI requests, the last `run_ai`. */
  aiWorker: AiWorkerStatus;
}

export interface SourcesViewInput {
  rotation?: { queries: readonly SearchQuery[]; history: ReadonlyMap<string, readonly QueryRunHistoryRow[]> };
  now: Date;
  month: string;
  channelsConfig: ChannelsConfig;
  aiConfig: Pick<AiConfig, "monthly_api_budget_usd"> & Partial<Pick<AiConfig, "providers">>;
  /** Stored provider health (`runtime_state`); missing = never used. */
  aiHealth?: ReadonlyMap<AiProviderId, ProviderHealth>;
  /** Job Radar's own usage cap per subscription CLI (`readQuotaStatuses`); missing = off or not readable. */
  aiQuota?: ReadonlyMap<AiProviderId, QuotaStatus>;
  /** Providers whose API key is set; absent id = configured (CLI providers, and callers that do not care). */
  aiConfigured?: Partial<Record<AiProviderId, boolean>>;
  /** Latest `ai_usage` record per provider: a provider used before health tracking existed still has a last success. */
  aiLastUsedAt?: ReadonlyMap<string, Date>;
  /** Time zone the "today" of the request caps is read in (schedule.yaml). */
  timeZone?: string;
  /** The model catalog; absent / null = models are shown without labels or marks. */
  catalog?: ModelsConfig | null;
  states: readonly ChannelStateRow[];
  runsByChannel: ReadonlyMap<string, RecentRun[]>;
  usage: ReadonlyMap<string, MonthUsage>;
  /** This month's runs per channel. */
  runTotals: ReadonlyMap<string, MonthRunTotals>;
  latestCycle: LatestCycleRuns | null;
  /** `listChannelCycleHistory`: the last `healthCycles` cycles per channel, oldest first. Omitted = no history. */
  history?: ReadonlyMap<string, readonly (ChannelCycleStat | null)[]>;
  /** Percent of a budget at which the batteries turn red; omitted = only when it is used up. */
  budgetAlertPercent?: number;
  /** How many of the newest cycles feed the trend line (`ui.yaml: trend_cycles`). */
  trendCycles?: number;
  /** How many cycles the health strip shows (`ui.yaml: health_cycles`). */
  healthCycles?: number;
  aiRows: readonly AiUsageRow[];
  apiSpendUsd: number;
  lastHeartbeatAt: Date | null;
  heartbeatIntervalSeconds: number;
  heartbeatStaleFactor: number;
  /** The process environment, to name the variables a channel lacks (`missingEnv`); omitted = nothing is reported missing. */
  env?: Readonly<Record<string, string | undefined>>;
  /** `BRAVE_SEARCH_API_KEY` is set (default: yes, so callers that do not care show no "not configured" badge). */
  braveConfigured?: boolean;
  /** `TAVILY_API_KEY` is set (default: yes, like `braveConfigured`). */
  tavilyConfigured?: boolean;
  aiWorker: AiWorkerStatus;
  /** `APIFY_TOKEN` and `linkedin.apify.actor_id` are set (default: yes, so no "not configured" badge). */
  apifyConfigured?: boolean;
  /** `MONID_API_KEY` is set (default: yes, like `braveConfigured`). */
  monidConfigured?: boolean;
  /** `BRIGHT_DATA_API_KEY` is set (default: yes, like `braveConfigured`). */
  brightdataConfigured?: boolean;
  /** `JSEARCH_API_KEY` is set (default: yes, like `braveConfigured`). */
  jsearchConfigured?: boolean;
  /** `GMAIL_USER` and `GMAIL_APP_PASSWORD` are set (default: yes, like `braveConfigured`). */
  gmailConfigured?: boolean;
  /** The saved LinkedIn login; omitted = no login badge. */
  linkedinLogin?: LoginState;
}

const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** Cascade ids first (in cascade order), then every other configured channel in table order. */
function orderedChannelIds(config: ChannelsConfig): ConfiguredChannelId[] {
  const all = Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[];
  const cascade = new Set<string>(config.linkedin.cascade);
  return [...config.linkedin.cascade, ...all.filter((id) => !cascade.has(id))];
}

/** The LinkedIn session channels share one login. */
function isSessionChannel(id: string): boolean {
  return id === "linkedin-session" || id === "linkedin-session:recommended";
}

function notConfigured(id: string, input: Pick<SourcesViewInput, "braveConfigured" | "tavilyConfigured" | "apifyConfigured" | "monidConfigured" | "brightdataConfigured" | "jsearchConfigured" | "gmailConfigured">): boolean {
  if (id === "brave") return input.braveConfigured === false;
  if (id === "tavily") return input.tavilyConfigured === false;
  if (id === "linkedin-apify") return input.apifyConfigured === false;
  if (id === "linkedin-monid") return input.monidConfigured === false;
  if (id === "linkedin-brightdata") return input.brightdataConfigured === false;
  if (id === "jsearch") return input.jsearchConfigured === false;
  if (id === "gmail-alerts") return input.gmailConfigured === false;
  return false;
}

/** The default model of `provider`, labelled and flagged by the catalog. */
export function providerModel(provider: AiProviderId, model: string | undefined, catalog: ModelsConfig | null): AiProviderModel {
  if (model === undefined) {
    const fallback = catalog ? cliDefaultModel(catalog) : null;
    return { id: null, label: fallback?.label ?? fallback?.id ?? null, status: "cliDefault" };
  }
  if (!catalog) return { id: model, label: null, status: "ok" };
  const found = findCatalogModel(catalog, provider, model);
  if (!found || found.by !== "id") return { id: model, label: null, status: "missing" };
  return { id: model, label: found.model.label ?? null, status: found.model.deprecated ? "deprecated" : "ok" };
}

/** One view per AI provider (the /sources health card and the provider marks of the settings page). */
export function buildProviderViews(input: Pick<SourcesViewInput, "now" | "aiConfig" | "aiHealth" | "aiQuota" | "aiConfigured" | "aiLastUsedAt" | "timeZone" | "catalog">): AiProviderView[] {
  const providers = input.aiConfig.providers;
  if (!providers) return [];
  const today = healthDay(input.now, input.timeZone ?? "UTC");
  return AI_PROVIDER_IDS.map((id) => {
    const policy = providers[POLICY_KEY[id]];
    const health = input.aiHealth?.get(id);
    const view = {
      id,
      enabled: policy.enabled,
      configured: input.aiConfigured?.[id] !== false,
      dailyCap: policy.daily_request_cap,
      requestsToday: health ? requestsOn(health, today) : 0,
      lastSuccessAt: health?.lastSuccessAt ?? input.aiLastUsedAt?.get(id) ?? null,
      lastErrorAt: health?.lastErrorAt ?? null,
      lastErrorKind: health?.lastErrorKind ?? null,
      lastErrorMessage: health?.lastErrorMessage ?? null,
      coolingUntil: health && isCoolingDown(health, input.now) ? health.coolingUntil : null,
    };
    const status = input.aiQuota?.get(id);
    const quota: AiProviderQuota | null = status
      ? { level: status.level, reason: status.reason, resumeAt: status.resumeAt, windowRequests: status.windowRequests, hardRequests: status.hardRequests, windowHours: status.windowHours }
      : null;
    // the window cap shows as `guarded`, with the later of its own and a running cooldown's resume time
    const guardedUntil = quota?.level === "hard" && quota.reason === "window" ? (quota.resumeAt ?? view.coolingUntil ?? input.now) : null;
    const withGuard = { ...view, guardedUntil };
    return { ...withGuard, state: aiProviderState(withGuard), quota, model: providerModel(id, (policy as { model?: string }).model, input.catalog ?? null) };
  });
}

/** Pure: the per-cycle stats of one channel -> what its card draws. */
export function buildChannelHistory(stats: readonly (ChannelCycleStat | null)[], trendCycles: number, healthCycles: number): ChannelHistory {
  const healthStats = healthCycles > 0 ? stats.slice(-healthCycles) : [];
  const trendStats = trendCycles > 0 ? stats.slice(-trendCycles) : [];
  const newest = stats[stats.length - 1] ?? null;
  let skippedStreak = 0;
  for (const stat of [...stats].reverse()) {
    if (stat === null) continue;
    if (stat.runs === 0 || stat.skipped < stat.runs) break;
    skippedStreak += 1;
  }
  return {
    fetched: trendStats.map((stat) => (stat === null ? null : stat.fetched)),
    outcomes: healthStats.map(cycleOutcome),
    running: newest !== null && newest.running > 0,
    latest: newest === null ? null : { fetched: newest.fetched, newCount: newest.newCount },
    skippedStreak,
  };
}

interface StatusInput {
  registered: boolean;
  enabled: boolean;
  needsCredentials: boolean;
  circuit: CircuitView | null;
  health: ChannelStateRow["health"] | null;
  consecutiveFailures: number;
  outcomes: readonly (CycleOutcome | null)[];
  /** `ChannelHistory.skippedStreak`; omitted = 0. */
  skippedStreak?: number;
}

/** Pure: the one word a channel card shows. Switched off and not-yet-implemented come first, then what blocks it, then how the last cycles went. */
export function channelStatus(input: StatusInput): ChannelStatus {
  if (!input.registered) return "not_registered";
  if (!input.enabled) return "off";
  if (input.needsCredentials) return "missing_credentials";
  if (input.circuit === "open") return "open";
  if (input.circuit === "half_open") return "half_open";
  // The newest cycles were all skipped (nothing available / budget used up): it did nothing, whatever it did before.
  if ((input.skippedStreak ?? 0) > 0) return "degraded";
  const last = [...input.outcomes].reverse().find((o) => o !== null) ?? null;
  if (last === "fail") return "failing";
  if (last === "warn" || input.health === "degraded" || input.health === "down" || input.consecutiveFailures > 0) return "degraded";
  if (last === "ok") return "ok";
  return "idle";
}

export function buildSourcesView(input: SourcesViewInput): SourcesView {
  const states = new Map(input.states.map((row) => [row.id, row]));
  const latestByChannel = new Map((input.latestCycle?.channels ?? []).map((c) => [c.channelId, c]));

  const cards: SourceCard[] = orderedChannelIds(input.channelsConfig).map((id) => {
    const settings = settingsFromConfig(id, input.channelsConfig);
    const state = states.get(id);
    const used = input.usage.get(id) ?? { records: 0, usd: 0 };
    const history = buildChannelHistory(input.history?.get(id) ?? [], input.trendCycles ?? 0, input.healthCycles ?? 0);
    const circuit = state
      ? {
          state: effectiveState(
            { state: state.circuitState, consecutiveFailures: state.consecutiveFailures, openUntil: state.circuitOpenUntil, lastErrorCode: state.lastErrorCode, lastSuccessAt: state.lastSuccessAt },
            input.now,
          ),
          openUntil: state.circuitOpenUntil,
          consecutiveFailures: state.consecutiveFailures,
          lastErrorCode: state.lastErrorCode,
        }
      : null;
    const missingEnv = input.env ? missingChannelEnv(input.env, id) : [];
    const isNotConfigured = notConfigured(id, input);
    return {
      id,
      family: state?.family ?? null,
      kind: state?.kind ?? null,
      testable: state !== undefined && !(input.channelsConfig.test_channel.excluded_kinds as readonly string[]).includes(state.kind),
      registered: state !== undefined,
      enabled: settings.enabled,
      otherMarket: settings.otherMarket === true,
      markets: [...(settings.markets ?? [])],
      notConfigured: isNotConfigured,
      missingEnv,
      login: isSessionChannel(id) ? (input.linkedinLogin ?? null) : null,
      circuit,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      usage: {
        records: used.records,
        usd: roundUsd(used.usd),
        budgetUsd: settings.monthlyBudgetUsd,
        freeRecords: settings.freeRecordsPerMonth,
        activity: input.runTotals.get(id) ?? { runs: 0, fetched: 0, newCount: 0 },
      },
      runs: input.runsByChannel.get(id) ?? [],
      latestCycleRuns: latestByChannel.get(id) ?? null,
      history,
      status: channelStatus({
        registered: state !== undefined,
        enabled: settings.enabled,
        needsCredentials: settings.enabled && (isNotConfigured || missingEnv.length > 0),
        circuit: circuit?.state ?? null,
        health: state?.health ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        outcomes: history.outcomes,
        skippedStreak: history.skippedStreak,
      }),
      skipped: history.skippedStreak > 0 ? { cycles: history.skippedStreak, errorCode: (input.runsByChannel.get(id) ?? []).find((run) => run.status === "skipped")?.errorCode ?? null } : null,
    };
  });

  const quotaOf = (card: SourceCard | undefined): CascadeEntry["quota"] => {
    if (!card) return { kind: "none" };
    if (card.usage.freeRecords > 0) return { kind: "free", used: card.usage.records, limit: card.usage.freeRecords };
    if (card.usage.budgetUsd > 0) return { kind: "paid", used: card.usage.usd, limit: card.usage.budgetUsd };
    return { kind: "none" };
  };
  const byId = new Map(cards.map((card) => [card.id, card]));
  const entries: CascadeEntry[] = input.channelsConfig.linkedin.cascade.map((id, index) => ({
    id,
    position: index + 1,
    quota: quotaOf(byId.get(id)),
    enabled: byId.get(id)?.enabled ?? false,
    notConfigured: byId.get(id)?.notConfigured ?? false,
    login: byId.get(id)?.login ?? null,
    circuit: byId.get(id)?.circuit?.state ?? null,
    latest: latestByChannel.get(id) ?? null,
  }));

  let usedUsd = 0;
  for (const usage of input.usage.values()) usedUsd += usage.usd;

  let cascadeRotation: RotationStatus | undefined;
  if (input.channelsConfig.collect.query_rotation && input.rotation && input.rotation.queries.length > 0) {
    for (const unit of rotationUnits(input.channelsConfig)) {
      const unitCards = unit.channelIds.flatMap((id) => {
        const card = byId.get(id);
        return card ? [card] : [];
      });
      const sortChannel = unit.name === "cascade"
        ? cascadeStartChannel(unitCards, input.channelsConfig, input.usage, usedUsd)
        : unit.channelIds[0] ?? null;
      const rotation = rotationStatus({
        unit,
        queries: input.rotation.queries,
        history: input.rotation.history.get(unit.name) ?? [],
        sortChannel,
        collect: input.channelsConfig.collect,
        now: input.now,
      });
      if (unit.name === "cascade") cascadeRotation = rotation;
      else {
        const card = byId.get(unit.name);
        if (card) card.rotation = rotation;
      }
    }
  }

  const ageSeconds = computeHeartbeatAgeSeconds(input.lastHeartbeatAt, input.now);
  return {
    maxBackfillHours: input.channelsConfig.collect.max_backfill_hours,
    month: input.month,
    cards,
    cascade: { ...(cascadeRotation ? { rotation: cascadeRotation } : {}), entries, servedBy: entries.filter((e) => (e.latest?.succeeded ?? 0) > 0).map((e) => e.id) },
    paid: { usedUsd: roundUsd(usedUsd), capUsd: input.channelsConfig.paid_total_monthly_budget_usd },
    budgetAlertPercent: input.budgetAlertPercent ?? 100,
    healthCycles: input.healthCycles ?? 0,
    ai: {
      rows: [...input.aiRows],
      apiSpendUsd: roundUsd(input.apiSpendUsd),
      budgetUsd: input.aiConfig.monthly_api_budget_usd,
      totalCostUsd: roundUsd(input.aiRows.reduce((sum, row) => sum + row.costUsd, 0)),
      providers: buildProviderViews(input),
    },
    latestCycle: input.latestCycle,
    runner: {
      lastHeartbeatAt: input.lastHeartbeatAt,
      ageSeconds,
      online: ageSeconds !== null && ageSeconds <= input.heartbeatIntervalSeconds * input.heartbeatStaleFactor,
      intervalSeconds: input.heartbeatIntervalSeconds,
    },
    aiWorker: input.aiWorker,
  };
}
