import fs from "node:fs";
import path from "node:path";

import { createChannelContext } from "@/lib/channels/context";
import { FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import type { FetchLike } from "@/lib/channels/http";
import type { ChannelContext, HttpResponse, SearchQuery } from "@/lib/channels/types";
import type { JobspySettings } from "@/lib/channels/jobspy";

import { shippedChannels } from "../helpers";
import { fixtureMarket } from "../../pipeline/helpers";

export function loadJobspyFixture(name: "indeed" | "linkedin" | "google"): { site: string; count: number; jobs: Record<string, unknown>[]; warnings: string[] } {
  const file = path.join(import.meta.dirname, "..", "..", "fixtures", "jobspy", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as { site: string; count: number; jobs: Record<string, unknown>[]; warnings: string[] };
}

export function jobspySettings(overrides: Partial<JobspySettings> = {}): JobspySettings {
  const shipped = shippedChannels().jobspy;
  return { ...shipped, url: "http://jobspy.test:8000", country_indeed: shipped.country_indeed || "germany", market: fixtureMarket(), ...overrides };
}

export function httpResponse(status: number, body: unknown): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

export interface RecordedCall {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** A context whose fetch answers with `respond` and records the calls. */
export function jobspyContext(respond: (call: RecordedCall) => HttpResponse | Promise<HttpResponse>): { ctx: ChannelContext; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = { url, method: init.method, body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown) };
    calls.push(call);
    return respond(call);
  };
  const ctx = createChannelContext({
    channelId: "stub",
    settings: FIXTURE_SETTINGS,
    http: { timeoutMs: 1000, maxRetries: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: new AbortController().signal,
    cycle: { id: null, kind: "manual" },
    fetch,
    sleep: async () => {},
  });
  return { ctx, calls };
}

export function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    id: "q1",
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
