import { BudgetTracker } from "@/lib/channels/budget";
import { createChannelContext } from "@/lib/channels/context";
import type { DeliveryRecorder } from "@/lib/channels/delivery";
import type { FetchLike } from "@/lib/channels/http";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { settingsFromConfig } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { Channel, ChannelContext, ChannelLogger, ChannelRuntimeSettings, HttpResponse, SearchQuery } from "@/lib/channels/types";
import type { ChannelsConfig } from "@/lib/config";

import { channelsWith, shippedChannels } from "../../helpers";

export const SNAPSHOT_ID = "s_m4x7enmven8djfqak";
export const MONTH = "2026-10";
export const NOW = new Date("2026-10-07T08:00:00Z");

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
  body: unknown;
}

export interface FakeProviderOptions {
  /** Progress statuses answered in order; the last one repeats. Default: ready right away. */
  progress?: Array<string | HttpResponse>;
  /** Records delivered by the snapshot download. May depend on the trigger's limit_per_input. */
  records?: unknown[] | ((limitPerInput: number, inputs: unknown[]) => unknown[]);
  /** Raw snapshot download responses to answer first (e.g. 202), before the records. */
  snapshotFirst?: HttpResponse[];
  trigger?: HttpResponse;
}

export interface FakeProvider {
  fetch: FetchLike;
  requests: RecordedRequest[];
  /** Number of requests per phase. */
  count(phase: "trigger" | "progress" | "snapshot"): number;
}

/** A scripted Bright Data: trigger -> progress -> snapshot. */
export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const requests: RecordedRequest[] = [];
  let progressCalls = 0;
  let snapshotCalls = 0;
  let limit = 1;
  let inputs: unknown[] = [];
  const phaseOf = (path: string): "trigger" | "progress" | "snapshot" | "other" =>
    path.endsWith("/trigger") ? "trigger" : path.includes("/progress/") ? "progress" : path.includes("/snapshot/") ? "snapshot" : "other";

  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method ?? "GET", url, path: parsed.pathname, query: parsed.searchParams, headers: init.headers ?? {}, body });
    switch (phaseOf(parsed.pathname)) {
      case "trigger":
        limit = Number(parsed.searchParams.get("limit_per_input"));
        inputs = Array.isArray(body) ? body : [];
        return options.trigger ?? response(200, { snapshot_id: SNAPSHOT_ID });
      case "progress": {
        const steps = options.progress ?? ["ready"];
        const step = steps[Math.min(progressCalls, steps.length - 1)] ?? "ready";
        progressCalls += 1;
        return typeof step === "string" ? response(200, { status: step }) : step;
      }
      case "snapshot": {
        const first = options.snapshotFirst?.[snapshotCalls];
        snapshotCalls += 1;
        if (first) return first;
        const records = typeof options.records === "function" ? options.records(limit, inputs) : (options.records ?? []);
        return response(200, records);
      }
      default:
        return response(404, "");
    }
  };
  return {
    fetch,
    requests,
    count: (phase) => requests.filter((r) => phaseOf(r.path) === phase).length,
  };
}

export function brightConfig(edit: (raw: Record<string, unknown>) => void = () => {}): ChannelsConfig {
  return channelsWith(edit);
}

export function brightSettings(config: ChannelsConfig = shippedChannels()): ChannelRuntimeSettings {
  return settingsFromConfig("linkedin-brightdata", config);
}

export const ENV = { BRIGHT_DATA_API_KEY: "test-key-not-a-secret" } as const;

export function makeChannel(options: { cost?: number; environment?: Record<string, string | undefined> } = {}): Channel {
  return createBrightDataChannel({
    costPer1kUsd: () => options.cost ?? 1.5,
    environment: options.environment ?? ENV,
    now: () => NOW,
    sleep: async () => {},
  });
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
    maxResults: 10,
    ...overrides,
  };
}

export interface Harness {
  ctx: ChannelContext;
  tracker: BudgetTracker;
  logs: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  /** Warn-level lines only. */
  warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
}

/** A channel context wired to a fake provider and a real budget tracker (memory store). */
export async function harness(
  channel: Channel,
  provider: FakeProvider,
  options: { config?: ChannelsConfig; seed?: { records: number; usd: number }; cycleId?: number | null; deliveries?: DeliveryRecorder } = {},
): Promise<Harness> {
  const config = options.config ?? shippedChannels();
  const settings = brightSettings(config);
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
    signal: new AbortController().signal,
    cycle: { id: options.cycleId === undefined ? 1 : options.cycleId, kind: "manual" },
    logger,
    fetch: provider.fetch,
    sleep: async () => {},
    random: () => 0,
  });
  return { ctx, tracker, logs, warnings };
}
