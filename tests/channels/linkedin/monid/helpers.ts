import { BudgetTracker } from "@/lib/channels/budget";
import { createHttpClient, type FetchLike, type SleepFn } from "@/lib/channels/http";
import { createMonidChannel } from "@/lib/channels/linkedin/monid/channel";
import { monidSettingsSchema, type MonidSettings } from "@/lib/channels/linkedin/monid/contract";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { ChannelContext, ChannelLogger, ChannelRuntimeSettings, HttpResponse, SearchQuery } from "@/lib/channels/types";

import responses from "../../../fixtures/monid/responses.json";
import { fixtureMarket } from "../../../pipeline/helpers";

vi.mock("@/lib/channels/market", () => ({ marketForChannel: () => fixtureMarket() }));

export const FAKE_KEY = "fake-monid-key-never-a-secret";
export const NOW = new Date("2026-10-26T12:00:00Z");

/** Each test owns its configuration; no shipped sources.yaml or user configuration is read. */
export function settings(overrides: Partial<MonidSettings> = {}): MonidSettings {
  return monidSettingsSchema.parse({
    enabled: true, monthly_budget_usd: 1, throttle: { min_delay_ms: 0, max_delay_ms: 0 }, max_results: 300,
    api_base_url: "https://api.monid.ai", provider: "apify", endpoint: "/harvestapi/linkedin-job-search",
    price_per_1k_usd: 1, flat_fee_usd: 0.001, poll_interval_ms: 5, timeout_ms: 20, stop_grace_ms: 10,
    date_posted: { day: "24h", week: "week", month: "month", any: "" },
    input_template: { jobTitles: ["{keywords}"], locations: ["{location}"], maxItems: "{limit}", postedLimit: "{date_posted}", sortBy: "date" },
    remote_input: { workplaceType: ["remote"] }, remote_locations: {}, ...overrides,
  });
}

export function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { id: "query-example", keywords: ["Platform Engineer", "Infrastructure Engineer"], keywordGroup: "engineering",
    location: "Example City", remote: false, remoteScope: null, windowHours: 24, maxResults: 10, ...overrides };
}

export function response(status: number, body: unknown): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text, json: async (): Promise<unknown> => JSON.parse(text) };
}

export const completed = (overrides: Record<string, unknown> = {}) => ({ ...responses.completed, ...overrides });
export interface RecordedRequest {
  url: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: string | undefined;
  signal: AbortSignal;
}
export type Answer = HttpResponse | Error | ((request: RecordedRequest) => HttpResponse | Promise<HttpResponse>);

export async function harness(answers: Answer[] = [response(200, completed())], options: {
  settings?: MonidSettings;
  environment?: Record<string, string | undefined>;
  globalCapUsd?: number;
  seed?: { records: number; usd: number };
  sleep?: SleepFn;
  now?: () => Date;
} = {}) {
  const block = options.settings ?? settings();
  let time = NOW.getTime();
  const sleeps: number[] = [];
  const sleep: SleepFn = options.sleep ?? (async (ms, signal) => { signal?.throwIfAborted(); sleeps.push(ms); time += ms; });
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request: RecordedRequest = { url, path: new URL(url).pathname, method: init.method ?? "GET", headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) as Record<string, unknown> : {}, signal: init.signal, redirect: init.redirect };
    requests.push(request);
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    if (answer === undefined) throw new Error("No scripted response");
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(request) : answer;
  };
  const channel = createMonidChannel({ pricePer1kUsd: () => block.price_per_1k_usd, environment: options.environment ?? { MONID_API_KEY: FAKE_KEY },
    now: options.now ?? (() => new Date(time)), sleep, stopFetch: fetch });
  const runtime: ChannelRuntimeSettings = { enabled: block.enabled, maxResults: block.max_results, monthlyBudgetUsd: block.monthly_budget_usd,
    freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: block };
  const store = createMemoryStateStore();
  if (options.seed) await store.addUsage(channel.id, "2026-10", options.seed);
  const tracker = await BudgetTracker.create({ store, month: "2026-10", globalCapUsd: options.globalCapUsd ?? 10, settingsFor: () => runtime });
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const log = (level: string) => (message: string, fields?: Record<string, unknown>): void => { logs.push({ level, message, ...(fields ? { fields } : {}) }); };
  const logger: ChannelLogger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error"), child: () => logger };
  const controller = new AbortController();
  const ctx: ChannelContext = {
    http: createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 2, backoffBaseMs: 1, backoffMaxMs: 2 }, signal: controller.signal, fetch, logger, sleep, random: () => 0 }),
    budget: tracker.forChannel(channel), settings: runtime, signal: controller.signal, logger,
    cycle: { id: 1, kind: "manual" }, known: { payloads: async () => new Map() }, throttle: async () => {},
  };
  return { ctx, channel, requests, logs, sleeps, controller, tracker, fetch };
}
import { vi } from "vitest";

