import fs from "node:fs";
import path from "node:path";

import { BudgetTracker, type AttemptBudget, type UsageStore } from "@/lib/channels/budget";
import { createChannelContext } from "@/lib/channels/context";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { createJsearchChannel, type JsearchDeps } from "@/lib/channels/jsearch";
import { queryId } from "@/lib/channels/query";
import { settingsFromConfig } from "@/lib/channels/registry";
import type { Channel, ChannelContext, HttpResponse, SearchQuery } from "@/lib/channels/types";
import type { JsearchSettings } from "@/lib/config";
import type { MonthUsage } from "@/lib/db/repos/channels";

import { channelsWith, shippedChannels } from "../helpers";

export const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures/jsearch");
export const MONTH = "2026-10";
/** 7 October: 7 of 31 days gone, so the paced share of 200 requests is ceil(200 * 7 / 31) = 46. */
export const NOW = new Date("2026-10-07T08:00:00Z");
export const KEY_ENV = { JSEARCH_API_KEY: "test-key-not-real" } as const;

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

export function response(status: number, body: unknown = null, headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

export const shippedJsearch = (): JsearchSettings => shippedChannels().sources.jsearch;

/** sources.yaml with sources.jsearch changed (the result is re-validated). */
export function jsearchWith(edit: Partial<JsearchSettings>) {
  return channelsWith((raw) => {
    Object.assign((raw.sources as Record<string, Record<string, unknown>>).jsearch ?? {}, edit);
  });
}

export function memoryUsage(initial: Record<string, MonthUsage> = {}): UsageStore & { rows: Map<string, MonthUsage> } {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    loadUsage: async () => new Map(rows),
    addUsage: async (channelId, _month, delta) => {
      const used = rows.get(channelId) ?? { records: 0, usd: 0 };
      rows.set(channelId, { records: used.records + delta.records, usd: used.usd + delta.usd });
    },
  };
}

export interface Call {
  url: URL;
  headers: Record<string, string>;
}
export type Handler = (call: Call, n: number) => HttpResponse | Error;

export interface Harness {
  channel: Channel;
  ctx: ChannelContext;
  calls: Call[];
  sleeps: number[];
  logs: LogRecord[];
  usage: ReturnType<typeof memoryUsage>;
  budget: AttemptBudget;
  /** Books `usd` for another channel, as a concurrent unit of the cycle would (the global cap shrinks under this channel's feet). */
  spendElsewhere(usd: number): Promise<void>;
  /** Cancels the cycle's signal. */
  abort(): void;
}

/** A jsearch channel and a context wired to a real budget tracker and a fake network. */
export async function harness(
  handler: Handler,
  options: { settings?: Partial<JsearchSettings>; usage?: Record<string, MonthUsage>; deps?: JsearchDeps; paidCapUsd?: number; known?: ReadonlyMap<string, unknown>; usageStore?: UsageStore } = {},
): Promise<Harness> {
  const channels = options.settings ? jsearchWith({ enabled: true, ...options.settings }) : jsearchWith({ enabled: true });
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: LogRecord[] = [];
  const usage = memoryUsage(options.usage);
  const store = options.usageStore ?? usage;
  const channel = createJsearchChannel({ settings: () => channels.sources.jsearch, environment: KEY_ENV, now: () => NOW, ...options.deps });
  const settings = settingsFromConfig("jsearch", channels);
  const tracker = await BudgetTracker.create({
    store,
    month: MONTH,
    globalCapUsd: options.paidCapUsd ?? channels.paid_total_monthly_budget_usd,
    settingsFor: (id) => (id === "jsearch" ? settings : id === "elsewhere" ? { ...settings, monthlyBudgetUsd: 1000 } : undefined),
  });
  const budget = tracker.forChannel(channel);
  const controller = new AbortController();
  const ctx = createChannelContext({
    channelId: "jsearch",
    settings,
    http: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget,
    signal: controller.signal,
    cycle: { id: null, kind: "manual" },
    known: { payloads: async (ids) => new Map([...(options.known ?? new Map<string, unknown>())].filter(([id]) => ids.includes(id))) },
    logger: createLogger({ sink: (r) => logs.push(r), minLevel: "debug" }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    fetch: async (url, init) => {
      const call: Call = { url: new URL(url), headers: init.headers ?? {} };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const spendElsewhere = async (usd: number): Promise<void> => {
    await tracker.forChannel({ ...channel, id: "elsewhere" }).consume(1, { costUsd: usd, allowOverspend: true });
  };
  return { channel, ctx, calls, sleeps, logs, usage, budget, spendElsewhere, abort: () => controller.abort() };
}

export function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  const keywords = overrides.keywords ?? ["AI Engineer", "LLM Engineer"];
  return {
    id: queryId({ keywords, keywordGroup: "engineering", location: "Berlin", remote: false, remoteScope: null }),
    keywords,
    keywordGroup: "engineering",
    location: "Berlin",
    remote: false,
    remoteScope: null,
    windowHours: 24,
    maxResults: 25,
    ...overrides,
  };
}

export const SEARCH_PAGE = fixture("search-page.json");
export const SEARCH_EMPTY = fixture("search-empty.json");
export const DETAILS = fixture("job-details.json");
export const SEARCH_V2 = fixture("search-v2-sample.json");
export const RECORDS = SEARCH_PAGE.data as Array<Record<string, unknown>>;
export const ID_DIRECT = String(RECORDS[0]?.job_id);
export const ID_AGGREGATOR = String(RECORDS[1]?.job_id);
export const ID_NO_DESCRIPTION = String(RECORDS[2]?.job_id);
export const ID_BROKEN = String(RECORDS[3]?.job_id);

/** Routes `/search` to `page` and `/job-details` to the details fixture. */
export function api(options: { page?: unknown; details?: unknown } = {}): Handler {
  return ({ url }) => {
    if (url.pathname === "/search") return response(200, options.page ?? SEARCH_PAGE);
    if (url.pathname === "/job-details") return response(200, options.details ?? DETAILS);
    return response(404, { message: "no such endpoint" });
  };
}
