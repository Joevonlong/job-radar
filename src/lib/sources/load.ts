/** Reads everything `/sources` shows (server only) and folds it with `buildSourcesView`. */
import { buildQueries } from "@/lib/channels/query";
import { monthKey } from "@/lib/channels/budget";
import { loadConfig, reloadConfig, type AiConfig, type ModelsConfig } from "@/lib/config";
import {
  getAiUsageForMonth,
  getDb,
  getDbNow,
  type Db,
  getLatestCycleRuns,
  getLastAiUsageAt,
  getLatestHeartbeat,
  getMonthRunTotals,
  getMonthUsage,
  getQueryRotationHistory,
  listChannelCycleHistory,
  listChannelStates,
  listRecentRunsByChannel,
} from "@/lib/db";
import { listProviderHealth, type ProviderHealth } from "@/lib/ai/health";
import { createDbQuotaStore, readQuotaStatuses, type QuotaStatus } from "@/lib/ai/quota-guard";
import type { AiProviderId } from "@/lib/ai/types";
import { API_PROVIDER_IDS } from "@/lib/ai/usage";
import { sumAiCostForMonth } from "@/lib/db/repos/ai-usage";
import { BRAVE_API_KEY_ENV } from "@/lib/channels/discovery/brave";
import { TAVILY_API_KEY_ENV } from "@/lib/channels/discovery/tavily";
import { BRIGHTDATA_API_KEY_ENV } from "@/lib/channels/linkedin/brightdata/contract";
import { APIFY_TOKEN_ENV } from "@/lib/channels/linkedin/apify/contract";
import { MONID_API_KEY_ENV } from "@/lib/channels/linkedin/monid/contract";
import { GMAIL_APP_PASSWORD_ENV, GMAIL_USER_ENV } from "@/lib/channels/email";
import { JSEARCH_API_KEY_ENV } from "@/lib/channels/jsearch";
import { readAuthFileInfo, resolveAuthFile } from "@/lib/channels/linkedin/session/auth-file";
import { AUTH_FLAG_KEY, loginStateOf, readAuthFlag } from "@/lib/channels/linkedin/session/auth-state";
import { getRuntimeState } from "@/lib/db/repos/runtime-state";
import { loadRunnerEnv } from "@/lib/env";
import { loadAiWorkerStatus } from "@/lib/ops/ai-worker";
import { HEARTBEAT_STALE_FACTOR, RUNS_PER_CHANNEL } from "@/lib/settings/constants";

import { rotationUnits } from "./rotation-status";
import { buildProviderViews, buildSourcesView, type AiProviderView, type SourcesView } from "./view";

/** Which API providers have their key in this process's environment (the CLIs are on the host: they count as configured). */
function aiKeysPresent(): Partial<Record<"anthropic" | "deepseek" | "mimo", boolean>> {
  return {
    anthropic: (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "",
    deepseek: (process.env.DEEPSEEK_API_KEY ?? "").trim() !== "",
    mimo: (process.env.MIMO_API_KEY ?? "").trim() !== "",
  };
}

/** models.yaml read fresh (the web process has no config watcher); an unreadable file means "no labels, no marks". */
function readCatalog(): ModelsConfig | null {
  try {
    return reloadConfig("models");
  } catch {
    return null;
  }
}

/** The AI provider views alone (the settings page marks the providers that cannot run). */
export async function loadAiProviderViews(db: Db, now: Date): Promise<AiProviderView[]> {
  const aiConfig = loadConfig("ai");
  const [aiHealth, aiLastUsedAt] = await Promise.all([listProviderHealth(db).catch(() => new Map<AiProviderId, ProviderHealth>()), getLastAiUsageAt(db).catch(() => new Map<string, Date>())]);
  const aiQuota = await loadQuota(db, aiConfig, aiHealth, now);
  return buildProviderViews({ now, aiConfig, aiHealth, aiQuota, aiLastUsedAt, aiConfigured: aiKeysPresent(), timeZone: loadConfig("schedule").timezone, catalog: readCatalog() });
}

/** Job Radar's own usage cap per subscription CLI, read live (nothing is stored); an unreadable state counts as "no numbers". */
async function loadQuota(db: Db, aiConfig: AiConfig, aiHealth: ReadonlyMap<AiProviderId, ProviderHealth>, now: Date): Promise<Map<AiProviderId, QuotaStatus>> {
  try {
    return new Map(await readQuotaStatuses(createDbQuotaStore(db), aiConfig, aiHealth, now));
  } catch {
    return new Map();
  }
}

/** `at` defaults to the database clock: heartbeats and runs are stamped by it. */
export async function loadSourcesView(at?: Date): Promise<SourcesView> {
  const db = getDb();
  const now = at ?? (await getDbNow(db));
  const channelsConfig = loadConfig("channels");
  const aiConfig = loadConfig("ai");
  const timeZone = loadConfig("schedule").timezone;
  const month = monthKey(now, timeZone);
  // the web process has no config watcher and ui.yaml is meant to be edited while the page is open
  const ui = reloadConfig("ui");
  const budgetAlertPercent = Math.round(Math.min(...reloadConfig("notify").alerts.budget_thresholds) * 100);
  let queries: ReturnType<typeof buildQueries> = [];
  try {
    if (channelsConfig.collect.query_rotation) queries = buildQueries(loadConfig("search"), "manual");
  } catch {
    // Search is optional here; omit rotation when its queries cannot be built.
  }
  const historyCycles = Math.max(ui.trend_cycles, ui.health_cycles);

  const [states, history, runsByChannel, usage, runTotals, latestCycle, aiRows, apiSpendUsd, heartbeat, aiWorker, aiHealth, aiLastUsedAt, rotationHistory] = await Promise.all([
    listChannelStates(db),
    listChannelCycleHistory(db, historyCycles),
    listRecentRunsByChannel(db, RUNS_PER_CHANNEL),
    getMonthUsage(db, month),
    getMonthRunTotals(db, { month, timeZone }),
    getLatestCycleRuns(db),
    getAiUsageForMonth(db, { month, timeZone }),
    sumAiCostForMonth(db, { month, timeZone, providers: API_PROVIDER_IDS }),
    getLatestHeartbeat(db),
    loadAiWorkerStatus(db, { now, aiConfig }),
    listProviderHealth(db).catch(() => new Map<AiProviderId, ProviderHealth>()),
    getLastAiUsageAt(db).catch(() => new Map<string, Date>()),
    queries.length > 0
      // History is optional; omit the status rather than logging database error details.
      ? getQueryRotationHistory(db, { units: rotationUnits(channelsConfig), queryHashes: queries.map((query) => query.id) }).catch(() => undefined)
      : undefined,
  ]);
  const aiQuota = await loadQuota(db, aiConfig, aiHealth, now);

  // The saved LinkedIn login. A flag that cannot be read counts as "no flag" (the file alone decides).
  const authFlag = await getRuntimeState(db, AUTH_FLAG_KEY).then((row) => readAuthFlag(row?.value), () => null);
  const linkedinLogin = loginStateOf(readAuthFileInfo(resolveAuthFile(channelsConfig.linkedin.session.site.auth_file)), authFlag, now);

  return buildSourcesView({
    now,
    month,
    channelsConfig,
    ...(rotationHistory ? { rotation: { queries, history: rotationHistory } } : {}),
    aiConfig,
    aiHealth,
    aiQuota,
    aiLastUsedAt,
    aiConfigured: aiKeysPresent(),
    timeZone,
    catalog: readCatalog(),
    states,
    runsByChannel,
    usage,
    runTotals,
    latestCycle,
    history,
    budgetAlertPercent,
    trendCycles: ui.trend_cycles,
    healthCycles: ui.health_cycles,
    aiRows,
    apiSpendUsd,
    lastHeartbeatAt: heartbeat?.at ?? null,
    heartbeatIntervalSeconds: loadRunnerEnv().RUNNER_HEARTBEAT_SECONDS,
    heartbeatStaleFactor: HEARTBEAT_STALE_FACTOR,
    env: process.env,
    braveConfigured: (process.env[BRAVE_API_KEY_ENV] ?? "").trim() !== "",
    tavilyConfigured: (process.env[TAVILY_API_KEY_ENV] ?? "").trim() !== "",
    aiWorker,
    apifyConfigured: (process.env[APIFY_TOKEN_ENV] ?? "").trim() !== "" && channelsConfig.linkedin.apify.actor_id.trim() !== "",
    monidConfigured: (process.env[MONID_API_KEY_ENV] ?? "").trim() !== "",
    brightdataConfigured: (process.env[BRIGHTDATA_API_KEY_ENV] ?? "").trim() !== "",
    jsearchConfigured: (process.env[JSEARCH_API_KEY_ENV] ?? "").trim() !== "",
    gmailConfigured: (process.env[GMAIL_USER_ENV] ?? "").trim() !== "" && (process.env[GMAIL_APP_PASSWORD_ENV] ?? "").trim() !== "",
    linkedinLogin,
  });
}
