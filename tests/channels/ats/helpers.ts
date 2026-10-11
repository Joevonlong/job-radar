import fs from "node:fs";
import path from "node:path";

import type { AtsBoardStore, AtsDeps, AtsInputs } from "@/lib/channels/ats";
import { createMemoryAtsBoardStore } from "@/lib/channels/ats";
import { createChannelContext } from "@/lib/channels/context";
import type { FetchLike } from "@/lib/channels/http";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import type { ChannelContext, HttpResponse, SearchQuery } from "@/lib/channels/types";
import { buildSweepQuery } from "@/lib/channels/query";
import { configRegistry, type ChannelsConfig, type CompanyEntry } from "@/lib/config";

import { shippedSearch } from "../helpers";
import { shippedYaml } from "../../config/helpers";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/ats");

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
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

export interface RecordedRequest {
  body?: string | undefined;
  url: string;
  headers: Record<string, string>;
}

/** A fetch answering per URL (substring match, first hit); unknown URLs fail the test. Records every request. */
export function routedFetch(routes: Array<[match: string, answer: HttpResponse | ((req: RecordedRequest) => HttpResponse)]>): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const request = { url, headers: init.headers ?? {}, body: init.body };
      requests.push(request);
      const hit = routes.find(([match]) => url.includes(match));
      if (!hit) throw new Error(`unexpected request ${url}`);
      const [, answer] = hit;
      return typeof answer === "function" ? answer(request) : answer;
    },
  };
}

export function company(overrides: Partial<CompanyEntry> & Pick<CompanyEntry, "name" | "ats" | "token">): CompanyEntry {
  return { enabled: true, ...overrides };
}

export function inputs(
  companies: CompanyEntry[],
  extra: { watched?: string[] } = {},
): AtsInputs {
  const interests = configRegistry.interests.schema.parse({
    ...shippedYaml("interests.yaml"),
    watched_companies: extra.watched ?? [],
  });
  return { companies: { companies }, search: shippedSearch(), interests };
}

/** Prefilter settings that add and drop nothing beyond the search.yaml keywords: tests do not depend on the shipped term lists. */
export const NEUTRAL_PREFILTER = { enabled: true, include_terms: [], exclude_terms: [] };

const ATS_IDS = ["greenhouse", "lever", "ashby", "personio", "smartrecruiters"] as const;

function neutralChannelsYaml(): { sources: Record<string, Record<string, unknown>> } {
  const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: Record<string, Record<string, unknown>> };
  for (const id of ATS_IDS) {
    const block = raw.sources[id];
    if (block) block.title_prefilter = structuredClone(NEUTRAL_PREFILTER);
  }
  return raw;
}

/** The shipped sources.yaml, but with neutral prefilters. */
export function neutralChannels(): ChannelsConfig {
  return configRegistry.channels.schema.parse(neutralChannelsYaml());
}

/** sources.yaml with neutral prefilters (see NEUTRAL_PREFILTER) and one block edited. */
export function atsChannelsWith(id: (typeof ATS_IDS)[number], edit: (block: Record<string, unknown>) => void): ChannelsConfig {
  const raw = neutralChannelsYaml();
  const block = raw.sources[id];
  if (!block) throw new Error(`no block for ${id}`);
  edit(block);
  return configRegistry.channels.schema.parse(raw);
}

export interface AtsHarness {
  ctx: ChannelContext;
  query: SearchQuery;
  logs: LogRecord[];
  sleeps: number[];
}

export function atsContext(
  id: ConfiguredChannelId,
  fetch: FetchLike,
  options: { cycleId?: number | null; channels?: ChannelsConfig; signal?: AbortSignal; budget?: ChannelContext["budget"] } = {},
): AtsHarness {
  const channels = options.channels ?? neutralChannels();
  const logs: LogRecord[] = [];
  const sleeps: number[] = [];
  const settings = settingsFromConfig(id, channels);
  const ctx = createChannelContext({
    channelId: id,
    settings,
    http: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: options.budget ?? {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: options.signal ?? new AbortController().signal,
    cycle: { id: options.cycleId === undefined ? 1 : options.cycleId, kind: "manual" },
    logger: createLogger({ sink: (r) => logs.push(r), minLevel: "debug" }),
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  // the sweep query the framework hands to usesQueries=false channels, capped like collect.ts does
  const sweep = buildSweepQuery(shippedSearch(), "manual");
  const query = { ...sweep, maxResults: Math.min(sweep.maxResults, settings.maxResults) };
  return { ctx, query, logs, sleeps };
}

export function depsWith<S extends AtsBoardStore = ReturnType<typeof createMemoryAtsBoardStore>>(
  inputsValue: AtsInputs,
  store: S = createMemoryAtsBoardStore() as unknown as S,
): AtsDeps & { memory: S } {
  return { inputs: () => inputsValue, store: () => store, memory: store };
}
