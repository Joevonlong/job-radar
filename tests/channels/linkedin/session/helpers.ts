import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

import { BudgetTracker } from "@/lib/channels/budget";
import { createChannelContext } from "@/lib/channels/context";
import { writeAuthFile } from "@/lib/channels/linkedin/session/auth-file";
import type { BrowserOptions, LoadedPage, LoadOptions, OpenBrowser } from "@/lib/channels/linkedin/session/browser";
import { createSessionChannels, type SessionChannelDeps } from "@/lib/channels/linkedin/session/channel";
import { Mutex } from "@/lib/channels/linkedin/session/browser";
import { createMemorySessionStore } from "@/lib/channels/linkedin/session/store";
import { settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { Channel, ChannelContext, ChannelLogger, KnownPostings, SearchQuery } from "@/lib/channels/types";
import type { ChannelsConfig } from "@/lib/config";

import { channelsWith, shippedChannels } from "../../helpers";

export const NOW = new Date("2026-10-07T08:00:00Z");
export const MONTH = "2026-10";
export const TIME_ZONE = "Europe/Berlin";
const FIXTURES = path.join(import.meta.dirname, "../../../fixtures/linkedin-session");

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** A storage state that looks like a logged-in LinkedIn browser (the cookie value is a placeholder, not a secret). */
export function loggedInState(options: { expires?: number } = {}): unknown {
  return {
    cookies: [
      { name: "li_at", value: "placeholder-not-a-secret", domain: ".www.linkedin.com", path: "/", expires: options.expires ?? Math.floor(NOW.getTime() / 1000) + 86_400 * 90, httpOnly: true, secure: true, sameSite: "None" },
      { name: "JSESSIONID", value: "placeholder", domain: ".www.linkedin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "None" },
    ],
    origins: [],
  };
}

const tempDirs = new Set<string>();
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobradar-linkedin-session-"));
  tempDirs.add(dir);
  return dir;
}

/** An auth file path in a fresh temp dir; the file exists (logged in) unless `login` is false. */
export function authFileIn(options: { login?: boolean; expires?: number } = {}): string {
  const file = path.join(tempDir(), ".auth", "linkedin.json");
  if (options.login !== false) writeAuthFile(file, loggedInState(options.expires === undefined ? {} : { expires: options.expires }));
  return file;
}

/** What the fake LinkedIn answers for one URL. */
export interface FakeAnswer {
  html: string;
  status?: number;
  /** The URL after a redirect (default: the requested one). */
  url?: string;
  /** The page never loads: the browser throws Playwright's `TimeoutError` (the answer's other fields are ignored). */
  timeout?: boolean;
}

export type FakeSite = (url: URL) => FakeAnswer;

export interface FakeBrowserLog {
  opened: BrowserOptions[];
  loads: Array<{ url: string; scrollList: boolean }>;
  closed: number;
}

/** A browser that serves pages from `site` and records what was opened. Nothing else can be done with it: it has no click or type. */
export function fakeBrowser(site: FakeSite): { open: OpenBrowser; log: FakeBrowserLog } {
  const log: FakeBrowserLog = { opened: [], loads: [], closed: 0 };
  const open: OpenBrowser = async (options) => {
    log.opened.push(options);
    return {
      async load(url: string, loadOptions: LoadOptions): Promise<LoadedPage> {
        log.loads.push({ url, scrollList: loadOptions.scrollList });
        const answer = site(new URL(url));
        if (answer.timeout) {
          const error = new Error(`page.goto: Timeout 30000ms exceeded at ${url}\nCall log: ...`);
          error.name = "TimeoutError";
          throw error;
        }
        return { url: answer.url ?? url, status: answer.status ?? 200, html: answer.html };
      },
      async close() {
        log.closed += 1;
      },
    };
  };
  return { open, log };
}

/** job id -> fixture page, for the job pages of `/jobs/view/<id>/`. */
export const DETAIL_PAGES: Record<string, FakeAnswer> = {
  "4385000101": { html: fixture("job-detail.html") },
  "4385000102": { html: fixture("job-detail-de.html") },
  "4385000103": { html: fixture("job-detail-closed.html") },
  "4385000104": { html: fixture("job-detail-jsonld-only.html") },
  "4385000106": { html: fixture("job-unavailable.html"), status: 404 },
  "4385000201": { html: fixture("job-detail.html") },
  "4385000202": { html: fixture("job-detail-de.html") },
};

/** The happy-path LinkedIn: page 1 of a search is `search-results.html`, later pages are empty, job pages come from `DETAIL_PAGES`. */
export function happySite(overrides: Partial<Record<"search" | "recommended" | "detail", (url: URL) => FakeAnswer | null>> = {}): FakeSite {
  return (url) => {
    const custom = url.pathname.startsWith("/jobs/search/") ? overrides.search : url.pathname.startsWith("/jobs/collections/recommended/") ? overrides.recommended : overrides.detail;
    const answered = custom?.(url);
    if (answered) return answered;
    if (url.pathname.startsWith("/jobs/search/")) return { html: fixture(url.searchParams.has("start") ? "search-results-empty.html" : "search-results.html") };
    if (url.pathname.startsWith("/jobs/collections/recommended/")) return { html: fixture(url.searchParams.has("start") ? "search-results-empty.html" : "recommended.html") };
    const id = /\/jobs\/view\/(\d+)\//.exec(url.pathname)?.[1];
    return (id !== undefined ? DETAIL_PAGES[id] : undefined) ?? { html: fixture("job-unavailable.html"), status: 404 };
  };
}

export function sessionConfig(edit: (session: Record<string, unknown>) => void = () => {}): ChannelsConfig {
  return channelsWith((raw) => {
    const session = (raw.linkedin as Record<string, Record<string, unknown>>).session;
    if (!session) throw new Error("no session block");
    session.enabled = true;
    edit(session);
  });
}

export interface ChannelSetup {
  session: Channel;
  recommended: Channel;
  store: ReturnType<typeof createMemorySessionStore>;
  browser: ReturnType<typeof fakeBrowser>;
  authFile: string;
  config: ChannelsConfig;
}

export function setup(
  options: {
    site?: FakeSite;
    login?: boolean;
    config?: ChannelsConfig;
    store?: ReturnType<typeof createMemorySessionStore>;
    now?: Date;
    schedule?: { enabled: boolean; cron: string };
    expires?: number;
  } = {},
): ChannelSetup {
  const config = options.config ?? sessionConfig();
  const authFile = authFileIn({ login: options.login ?? true, ...(options.expires === undefined ? {} : { expires: options.expires }) });
  const store = options.store ?? createMemorySessionStore();
  const browser = fakeBrowser(options.site ?? happySite());
  const now = options.now ?? NOW;
  const deps: SessionChannelDeps = {
    settings: () => config.linkedin.session,
    timeZone: () => TIME_ZONE,
    recommendedSchedule: () => ({ ...(options.schedule ?? { enabled: true, cron: "0 7 * * *" }), timezone: TIME_ZONE }),
    store: () => store,
    openBrowser: browser.open,
    now: () => now,
    authFile: () => authFile,
    mutex: new Mutex(),
  };
  return { ...createSessionChannels(deps), store, browser, authFile, config };
}

export function berlinQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    id: "q-berlin",
    keywords: ["AI Engineer", "LLM Engineer"],
    keywordGroup: "engineering",
    location: "Berlin",
    remote: false,
    remoteScope: null,
    windowHours: 24,
    maxResults: 25,
    ...overrides,
  };
}

export function remoteQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return berlinQuery({ id: "q-remote", location: null, remote: true, remoteScope: "home_country", ...overrides });
}

export interface Harness {
  ctx: ChannelContext;
  logs: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  throttles: number;
}

/** A channel context for `collect`: real budget tracker (memory), a counting throttle, no network. */
export async function harness(channel: Channel, config: ChannelsConfig, options: { cycleId?: number | null; kind?: "manual" | "weekday_morning"; id?: ConfiguredChannelId; known?: KnownPostings } = {}): Promise<Harness> {
  const settings = settingsFromConfig(options.id ?? (channel.id as ConfiguredChannelId), config);
  const tracker = await BudgetTracker.create({ store: createMemoryStateStore(), month: MONTH, globalCapUsd: config.paid_total_monthly_budget_usd, settingsFor: () => settings });
  const logs: Harness["logs"] = [];
  const warnings: Harness["warnings"] = [];
  const logger: ChannelLogger = {
    debug: () => {},
    info: (message, fields) => logs.push({ message, fields }),
    warn: (message, fields) => warnings.push({ message, fields }),
    error: () => {},
    child: () => logger,
  };
  const result: Harness = { ctx: undefined as unknown as ChannelContext, logs, warnings, throttles: 0 };
  const base = createChannelContext({
    channelId: channel.id,
    settings,
    http: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: tracker.forChannel(channel),
    signal: new AbortController().signal,
    cycle: { id: options.cycleId === undefined ? 1 : options.cycleId, kind: options.kind ?? "manual" },
    known: options.known,
    logger,
    sleep: async () => {},
    random: () => 0,
  });
  result.ctx = {
    ...base,
    throttle: async () => {
      result.throttles += 1;
    },
  };
  return result;
}

export { shippedChannels };
