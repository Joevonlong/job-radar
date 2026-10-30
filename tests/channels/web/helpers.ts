import fs from "node:fs";
import path from "node:path";

import { createChannelContext } from "@/lib/channels/context";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { queryId } from "@/lib/channels/query";
import type { ChannelContext, HttpResponse, KnownPostings, SearchQuery } from "@/lib/channels/types";

const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures");

/** A recorded page from tests/fixtures/<dir>/<name>. */
export function fixtureHtml(dir: "stepstone" | "xing", name: string): string {
  return fs.readFileSync(path.join(FIXTURES, dir, name), "utf8");
}

export function htmlResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

export interface Call {
  url: URL;
  headers: Record<string, string>;
}

export type Handler = (call: Call, n: number) => HttpResponse | Error;

export interface TestContext {
  ctx: ChannelContext;
  calls: Call[];
  sleeps: number[];
  records: LogRecord[];
}

/** A ChannelContext whose network is `handler`; `extra` is the channel's sources.yaml block. */
export function makeContext(handler: Handler, extra: Record<string, unknown>, options: { maxRetries?: number; signal?: AbortSignal; known?: KnownPostings } = {}): TestContext {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const records: LogRecord[] = [];
  const ctx = createChannelContext({
    channelId: "test",
    settings: {
      enabled: true,
      maxResults: Number(extra.max_results ?? 50),
      monthlyBudgetUsd: 0,
      companyQueries: true, freeRecordsPerMonth: 0,
      throttle: { minDelayMs: 1, maxDelayMs: 1 },
      extra,
    },
    http: { timeoutMs: 1000, maxRetries: options.maxRetries ?? 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: options.signal ?? new AbortController().signal,
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => records.push(r), minLevel: "debug" }),
    ...(options.known ? { known: options.known } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    fetch: async (url, init) => {
      const call: Call = { url: new URL(url), headers: init.headers ?? {} };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { ctx, calls, sleeps, records };
}

export function searchQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  const keywords = overrides.keywords ?? ["AI Engineer"];
  return {
    id: queryId({ keywords, keywordGroup: "engineering", location: "Berlin", remote: false, remoteScope: null }),
    keywords,
    keywordGroup: "engineering",
    location: "Berlin",
    remote: false,
    remoteScope: null, company: null,
    windowHours: 24,
    maxResults: 25,
    ...overrides,
  };
}
