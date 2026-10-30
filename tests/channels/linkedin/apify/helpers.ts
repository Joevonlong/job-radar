import fs from "node:fs";
import path from "node:path";

import { BudgetTracker } from "@/lib/channels/budget";
import { createChannelContext } from "@/lib/channels/context";
import type { DeliveryRecorder } from "@/lib/channels/delivery";
import type { FetchLike } from "@/lib/channels/http";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { settingsFromConfig } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { Channel, ChannelContext, ChannelLogger, ChannelRuntimeSettings, HttpResponse, SearchQuery } from "@/lib/channels/types";
import type { ChannelsConfig } from "@/lib/config";

import { channelsWith, shippedChannels } from "../../helpers";

export const MONTH = "2026-10";
export const NOW = new Date("2026-10-07T08:00:00Z");
export const ENV = { APIFY_TOKEN: "test-token-not-a-secret" } as const;

export const FIXTURE_ITEMS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../fixtures/apify/valig-berlin.json"), "utf8")) as unknown[];

export function response(status: number, body: unknown = "", headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FakeApify {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

/** A scripted Apify: every `run-sync-get-dataset-items` call answers the next entry (the last repeats). */
export function fakeApify(answers: Array<HttpResponse | ((request: RecordedRequest) => HttpResponse)> = [response(201, [])]): FakeApify {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: init.headers ?? {},
      body: init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>),
    };
    requests.push(request);
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    if (answer === undefined) return response(404, "");
    return typeof answer === "function" ? answer(request) : answer;
  };
  return { fetch, requests };
}

export function apifyConfig(edit: (apify: Record<string, unknown>, raw: Record<string, unknown>) => void = () => {}): ChannelsConfig {
  return channelsWith((raw) => {
    const block = (raw.linkedin as Record<string, Record<string, unknown>>).apify;
    if (!block) throw new Error("no apify block");
    edit(block, raw);
  });
}

export function apifySettings(config: ChannelsConfig = shippedChannels()): ChannelRuntimeSettings {
  return settingsFromConfig("linkedin-apify", config);
}

export function makeChannel(options: { environment?: Record<string, string | undefined>; actorId?: string; price?: number } = {}): Channel {
  return createApifyChannel({
    pricePer1kUsd: () => options.price ?? 0.4,
    ...(options.actorId === undefined ? {} : { actorId: () => options.actorId as string }),
    environment: options.environment ?? ENV,
    now: () => NOW,
  });
}

export function berlinQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    id: "q-berlin",
    keywords: ["AI Engineer", "LLM Engineer"],
    keywordGroup: "engineering",
    location: "Berlin",
    remote: false,
    remoteScope: null, company: null,
    windowHours: 24,
    maxResults: 10,
    ...overrides,
  };
}

export interface Harness {
  ctx: ChannelContext;
  tracker: BudgetTracker;
  logs: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
}

/** A channel context wired to a fake Apify and a real budget tracker (memory store). */
export async function harness(
  channel: Channel,
  apify: FakeApify,
  options: { config?: ChannelsConfig; seed?: { records: number; usd: number }; cycleId?: number | null; deliveries?: DeliveryRecorder; signal?: AbortSignal } = {},
): Promise<Harness> {
  const config = options.config ?? shippedChannels();
  const settings = apifySettings(config);
  const store = createMemoryStateStore();
  if (options.seed) await store.addUsage(channel.id, MONTH, options.seed);
  const tracker = await BudgetTracker.create({
    store,
    month: MONTH,
    globalCapUsd: config.paid_total_monthly_budget_usd,
    settingsFor: () => settings,
  });
  const logs: Harness["logs"] = [];
  const warnings: Harness["warnings"] = [];
  const logger: ChannelLogger = {
    debug: () => {},
    info: (message, fields) => logs.push({ message, fields }),
    warn: (message, fields) => warnings.push({ message, fields }),
    error: () => {},
    child: () => logger,
  };
  const ctx = createChannelContext({
    deliveries: options.deliveries,
    channelId: channel.id,
    settings,
    http: { timeoutMs: 1000, maxRetries: 2, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: tracker.forChannel(channel),
    signal: options.signal ?? new AbortController().signal,
    cycle: { id: options.cycleId === undefined ? 1 : options.cycleId, kind: "manual" },
    logger,
    fetch: apify.fetch,
    sleep: async () => {},
    random: () => 0,
  });
  return { ctx, tracker, logs, warnings };
}
