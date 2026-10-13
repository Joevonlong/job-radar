import { vi } from "vitest";

import { CHANNEL_CONFIG_TABLE } from "@/lib/channels/registry";
import { configRegistry, type ConfigLayersState, type DoctorConfig } from "@/lib/config";
import type { ChannelStateRow, LatestCycleRuns } from "@/lib/db/queries/sources";
import type { ShippedConfigReportRow } from "@/lib/db/repos/runtime-state";
import type { Locale } from "@/i18n/locale";
import { translatorFor } from "@/lib/i18n/node";
import { CHECK_GROUPS, checkTitle, type CheckResult, type CommandOutcome, type DoctorCheck, type DoctorContext, type DoctorProbes, type HttpOutcome } from "@/lib/ops/doctor";
import type { MarketSummary, MarketSummaryResult } from "@/lib/market/summary";
import type { RegistryPageData } from "@/lib/sources/registry/load";
import { buildRegistryView } from "@/lib/sources/registry/view";
import { buildSourcesView, type SourcesView, type SourcesViewInput } from "@/lib/sources/view";

import { shippedYaml } from "../../config/helpers";

/** Wednesday 14:00 in Berlin; the morning cycle (07:00 Berlin) ran, the evening one (17:00) is next. */
export const NOW = new Date("2026-10-07T12:00:00Z");
export const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

const raw = (file: string, edit?: (raw: Record<string, unknown>) => void): unknown => {
  const copy = structuredClone(shippedYaml(file));
  edit?.(copy);
  return copy;
};

export const ran = (stdout: string, exitCode = 0, stderr = ""): CommandOutcome => ({ kind: "ran", exitCode, stdout, stderr });
export const httpOk = (body = "{}"): HttpOutcome => ({ ok: true, status: 200, body, error: null });
export const httpDown = (error = "ECONNREFUSED"): HttpOutcome => ({ ok: false, status: null, body: null, error });

export const COMPOSE_NAMES = ["db", "web", "runner", "jobspy"] as const;

export function composeJson(overrides: Record<string, Record<string, unknown> | null> = {}): string {
  const base: Record<string, Record<string, unknown>> = {
    db: { Service: "db", State: "running", Health: "healthy", Publishers: [{ URL: "127.0.0.1", TargetPort: 5432, PublishedPort: 5433, Protocol: "tcp" }] },
    web: { Service: "web", State: "running", Health: "healthy", Publishers: [{ URL: "127.0.0.1", TargetPort: 3000, PublishedPort: 3000, Protocol: "tcp" }] },
    runner: { Service: "runner", State: "running", Health: "healthy", Publishers: [] },
    jobspy: { Service: "jobspy", State: "running", Health: "healthy", Publishers: [{ URL: "", TargetPort: 8000, PublishedPort: 0, Protocol: "tcp" }] },
  };
  const rows: Record<string, unknown>[] = [];
  for (const name of COMPOSE_NAMES) {
    const override = overrides[name];
    if (override === null) continue;
    rows.push({ ...base[name], ...override });
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

export const CLAUDE_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com" });
export const LAUNCHCTL_RUNNING = ["io.jobradar.ai-worker = {", "\tstate = running", "\tpid = 4242", "\tlast exit code = (never exited)", "}"].join("\n");
export const TAILSCALE_RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.example-tailnet.ts.net." } });
export const SERVE_OK = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "mac.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
/** Docker Desktop's data folder in the healthy context: on the project volume. */
export const DOCKER_DATA = "/Volumes/SSD/.docker-data";
export const PMSET_OK =[" autorestart          1", " sleep                0 (sleep prevented by powerd)", " womp                 1"].join("\n");

/** The running web and runner containers (full ids) and when they started; their shipped config reports came after. */
export const WEB_CONTAINER = `${"a1".repeat(6)}${"0".repeat(52)}`;
export const RUNNER_CONTAINER = `${"b2".repeat(6)}${"0".repeat(52)}`;
export const CONTAINERS_STARTED = ago(3600);
export const SHIPPED_ID = "c3".repeat(32);

export function inspectJson(rows: { id: string; service: string; startedAt?: string; running?: boolean; mounts?: { Destination: string; Source?: string; Name?: string }[] }[] = [
  { id: WEB_CONTAINER, service: "web" },
  { id: RUNNER_CONTAINER, service: "runner" },
]): string {
  return JSON.stringify(
    rows.map((row) => ({
      Id: row.id,
      State: { Running: row.running ?? true, StartedAt: row.startedAt ?? CONTAINERS_STARTED.toISOString() },
      Config: { Labels: { "com.docker.compose.project": "job-radar", "com.docker.compose.service": row.service } },
      Mounts: row.mounts ?? [{ Type: "bind", Source: "/srv/job-radar/data/config", Destination: "/app/data/config" }],
    })),
  );
}

/** The healthy shipped config reports: the web and runner from their containers, the ai-worker with launchd's PID. */
export function shippedReports(
  edit: Partial<Record<"web" | "runner" | "ai-worker", ShippedConfigReportRow | null>> = {},
): Record<"web" | "runner" | "ai-worker", ShippedConfigReportRow | null> {
  const row = (instance: string, pid: number, updatedAt: Date): ShippedConfigReportRow => ({
    report: { id: SHIPPED_ID, dir: "/app/config", instance, pid, startedAt: CONTAINERS_STARTED.toISOString() },
    updatedAt,
  });
  return {
    web: row(WEB_CONTAINER.slice(0, 12), 1, ago(3500)),
    runner: row(RUNNER_CONTAINER.slice(0, 12), 1, ago(20)),
    "ai-worker": row("mac.local", 4242, ago(5)),
    ...edit,
  };
}

/** A well-formed scrypt hash (all zero bytes; matches no password anyone would type). */
export const HEALTHY_PASSWORD_HASH = "scrypt:131072:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const FILE_KEYS = ["BRIGHT_DATA_API_KEY", "APIFY_TOKEN", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "JSEARCH_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD"] as const;

export function channelState(id: string, extra: Partial<ChannelStateRow> = {}): ChannelStateRow {
  return { id, family: id.startsWith("linkedin") ? "linkedin" : id, kind: "api", health: "healthy", circuitState: "closed", circuitOpenUntil: null, consecutiveFailures: 0, lastErrorCode: null, lastSuccessAt: ago(3600), ...extra };
}

export function sourcesView(extra: Partial<SourcesViewInput> = {}, channelsEdit?: (raw: Record<string, unknown>) => void): SourcesView {
  const channelsConfig = configRegistry.channels.schema.parse(raw("sources.yaml", channelsEdit));
  const latestCycle: LatestCycleRuns = {
    id: 1,
    kind: "weekday_morning",
    status: "succeeded",
    startedAt: new Date("2026-10-07T05:00:30Z"),
    finishedAt: new Date("2026-10-07T05:09:00Z"),
    channels: [{ channelId: "indeed", family: "indeed", runs: 3, succeeded: 3, failed: 0, skipped: 0, interrupted: 0, fetched: 40 }],
  };
  return buildSourcesView({
    now: NOW,
    month: "2026-10",
    channelsConfig,
    aiConfig: { monthly_api_budget_usd: 10 },
    states: Object.keys(CHANNEL_CONFIG_TABLE).map((id) => channelState(id)),
    runsByChannel: new Map(),
    usage: new Map(),
    runTotals: new Map(),
    latestCycle,
    aiRows: [],
    apiSpendUsd: 0,
    lastHeartbeatAt: ago(10),
    heartbeatIntervalSeconds: 30,
    heartbeatStaleFactor: 3,
    aiWorker: { execution: "host", online: true, lastHeartbeatAt: ago(5), ageSeconds: 5, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null },
    ...extra,
  });
}

/** The registry page data of a healthy install (nothing failing, mirror in step, no old files). */
export function registryData(overrides: Partial<RegistryPageData> = {}): RegistryPageData {
  const view = sourcesView();
  const config = configRegistry.channels.schema.parse(raw("sources.yaml"));
  return {
    view: buildRegistryView({ now: NOW, config, cards: view.cards, channelStats: new Map(), boardHealth: [], boardSeen: new Map() }),
    file: { mode: "current", label: "data/config/sources.yaml", invalid: null },
    mirror: { syncedAt: NOW.toISOString(), inSync: true },
    limits: { importMaxBytes: 524288, candidatesPageSize: 10 },
    alertPercent: 100,
    cycleRunning: false,
    ...overrides,
  };
}

export interface Overrides {
  probes?: Partial<DoctorProbes>;
  /** command line ("docker info --format {{.ServerVersion}}" ...) -> outcome; replaces the healthy default. */
  commands?: Record<string, CommandOutcome>;
  /** url -> outcome; replaces the healthy default. */
  urls?: Record<string, HttpOutcome>;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  uid?: number | null;
  settings?: Partial<DoctorConfig>;
  schedule?: (raw: Record<string, unknown>) => void;
  notify?: (raw: Record<string, unknown> & { telegram: Record<string, unknown> }) => void;
  ai?: (raw: Record<string, unknown>) => void;
  channels?: (raw: Record<string, unknown>) => void;
  /** language.yaml; default: the fixture's (Chinese), so the existing assertions read the Chinese texts. */
  language?: (raw: Record<string, unknown>) => void;
  /** The report's language; default zh. */
  locale?: Locale;
  now?: Date;
}

const COMMANDS: Record<string, CommandOutcome> = {
  "docker info --format {{.ServerVersion}}": ran("29.8.2\n"),
  "docker compose -p job-radar ps -a --format json": ran(composeJson()),
  "launchctl print gui/501/io.jobradar.ai-worker": ran(LAUNCHCTL_RUNNING),
  "docker ps --no-trunc --filter label=com.docker.compose.project=job-radar --format {{.ID}}": ran(`${WEB_CONTAINER}\n${RUNNER_CONTAINER}\n`),
  [`docker inspect ${WEB_CONTAINER} ${RUNNER_CONTAINER}`]: ran(inspectJson()),
  "claude auth status": ran(CLAUDE_JSON),
  "codex login status": ran("Logged in using ChatGPT\n"),
  "tailscale status --json": ran(TAILSCALE_RUNNING),
  "tailscale serve status --json": ran(SERVE_OK),
  "pmset -g": ran(PMSET_OK),
};

const URLS: Record<string, HttpOutcome> = {
  "http://127.0.0.1:3000/api/health": httpOk(JSON.stringify({ db: "ok", lastHeartbeatAt: null, heartbeatAgeSeconds: null })),
  "http://127.0.0.1:8000/health": httpOk(),
  "https://mac.example-tailnet.ts.net/api/health": httpOk(),
};

/** A context in which everything is healthy; tests change one thing and look at the one check that should notice. */
export function makeContext(overrides: Overrides = {}): DoctorContext & { probes: { [K in keyof DoctorProbes]: ReturnType<typeof vi.fn> & DoctorProbes[K] } } {
  const commands = { ...COMMANDS, ...overrides.commands };
  const urls = { ...URLS, ...overrides.urls };
  const schedule = configRegistry.schedule.schema.parse(raw("schedule.yaml", overrides.schedule));
  const notify = configRegistry.notify.schema.parse(
    raw("notify.yaml", (r) => {
      (r.telegram as Record<string, unknown>).enabled = true;
      r.public_base_url = "https://mac.example-tailnet.ts.net";
      overrides.notify?.(r as Record<string, unknown> & { telegram: Record<string, unknown> });
    }),
  );
  const ai = configRegistry.ai.schema.parse(raw("ai.yaml", overrides.ai));
  const channels = configRegistry.channels.schema.parse(raw("sources.yaml", overrides.channels));
  const language = configRegistry.language.schema.parse(raw("language.yaml", overrides.language));
  const locale = overrides.locale ?? "zh";
  const env: Record<string, string | undefined> = {
    TELEGRAM_BOT_TOKEN: "123456:ABC-test_token",
    TELEGRAM_CHAT_ID: "424242",
    ...Object.fromEntries(FILE_KEYS.map((key) => [key, "test-value"])),
    // a healthy install reached through tailscale serve has the web password set (a well-formed hash, not a real one)
    JOB_RADAR_WEB_PASSWORD_HASH: HEALTHY_PASSWORD_HASH,
    ...overrides.env,
  };
  const probes = {
    run: vi.fn(async (command: string, args: readonly string[]): Promise<CommandOutcome> => commands[[command, ...args].join(" ")] ?? { kind: "missing" }),
    http: vi.fn(async (url: string): Promise<HttpOutcome> => urls[url] ?? httpDown()),
    dbPing: vi.fn(async () => true),
    migrations: vi.fn(async () => ({ expected: { count: 17, latestAt: 1_791_700_000_000 }, applied: { count: 17, latestAt: 1_791_700_000_000 } })),
    sources: vi.fn(async () => sourcesView()),
    registry: vi.fn(async () => registryData()),
    unscoredJobs: vi.fn(async () => 12),
    profile: vi.fn(async () => ({ usable: true, missing: [] })),
    backups: vi.fn(async () => [{ name: "jobradar-20261007-033000.dump", path: "/b/jobradar-20261007-033000.dump", bytes: 5 * 1024 * 1024, modifiedAt: ago(10 * 3600), hasConfig: true }]),
    disk: vi.fn(async () => ({ freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 })),
    dockerData: vi.fn(async () => ({ path: DOCKER_DATA, source: "settings-store" as const })),
    sameVolume: vi.fn(async () => true),
    listDir: vi.fn(async () => [] as string[]),
    foreignOwned: vi.fn(async () => ({ scanned: 42, foreign: 0, sample: [] as string[], truncated: false })),
    configLayers: vi.fn(async () => configLayersState()),
    traps: vi.fn(async () => ({ state: "ok" as const, enabled: true, backlogWarn: 500, recentDays: 7, stats: { jobsWithTraps: 2, recentJobsWithTraps: 1, backlog: 0 } })),
    mcp: vi.fn(async () => ({ state: "ok" as const, enabled: false, tools: ["search_jobs", "get_job", "list_applications"] })),
    market: vi.fn(async () => marketSummary()),
    shippedConfigReports: vi.fn(async () => shippedReports()),
    setup: vi.fn(async () => ({ pending: false, state: { completed_at: "2026-10-01T08:00:00.000Z", completed_by: "wizard", steps: {} }, error: null, source: "user", path: "/u/setup.yaml" })),
    ...overrides.probes,
  } as unknown as DoctorContext["probes"] & { [K in keyof DoctorProbes]: ReturnType<typeof vi.fn> & DoctorProbes[K] };
  return {
    now: overrides.now ?? NOW,
    locale,
    t: translatorFor(locale, "doctor"),
    env,
    platform: overrides.platform ?? "darwin",
    uid: overrides.uid === undefined ? 501 : overrides.uid,
    config: { schedule, notify, ai, channels, language, languageProblem: null },
    settings: { ...schedule.doctor, ...overrides.settings },
    backupDir: "/b",
    appRoot: "/Volumes/SSD/work/job-radar",
    runnerMaxAgeSeconds: 120,
    probes,
  } as DoctorContext & { probes: { [K in keyof DoctorProbes]: ReturnType<typeof vi.fn> & DoctorProbes[K] } };
}

/** Run one check and return its results (titles filled in as `runDoctor` does). */
export async function results(check: DoctorCheck, ctx: DoctorContext): Promise<CheckResult[]> {
  const out = await check.run(ctx);
  return (Array.isArray(out) ? out : [out]).map((outcome) => ({ ...outcome, title: outcome.title ?? checkTitle(ctx, outcome.id) }));
}

export async function only(check: DoctorCheck, ctx: DoctorContext): Promise<CheckResult> {
  const list = await results(check, ctx);
  if (list.length !== 1) throw new Error(`expected one result from ${check.id}, got ${list.length}`);
  return list[0] as CheckResult;
}

export const GROUPS = CHECK_GROUPS;

/** A healthy pair of config directories, optionally changed. */
/** A resolved market (a pack bound to its country, one local channel on). */
export function marketSummary(edit: Partial<MarketSummary> = {}): MarketSummaryResult {
  return {
    ok: true,
    summary: {
      packId: "xx",
      packName: "Example",
      packLayer: "shipped",
      packDir: "/defaults/packs/xx",
      country: "DE",
      countryName: "Germany",
      currency: "EUR",
      homeLanguage: "de",
      locale: "de-DE",
      homeRegion: "eu",
      languageStep: true,
      channels: { running: ["board-a"], localOff: [], otherMarket: [] },
      channelsError: null,
      ...edit,
    },
  };
}

export function configLayersState(edit: Partial<ConfigLayersState> = {}): ConfigLayersState {
  return {
    defaultsDir: "config",
    userDir: "data/config",
    userDirExists: true,
    userDirWritable: true,
    userFiles: 10,
    notCopied: [],
    overrides: [],
    pendingMigrations: [],
    problems: [],
    ...edit,
  };
}
