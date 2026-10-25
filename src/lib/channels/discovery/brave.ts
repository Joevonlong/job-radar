import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import { marketForChannel } from "@/lib/channels/market";
import type { Channel, ChannelContext } from "@/lib/channels/types";
import { braveChannelSchema, loadCompanies, loadConfig, type BraveChannelSettings, type SearchConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";

import { DISCOVERABLE_ATS, searchHostsFor, type DiscoverableAts } from "./boards";
import { boardsFromHits, boardUrlOf, createDiscoveryChannel, discoveryQueryId, type DiscoveredBoard, type DiscoveryDeps, type DiscoveryProvider, type DiscoveryQuery } from "./shared";
import { createDbDiscoveryStore } from "./store";

export { boardUrlOf, type DiscoveredBoard, type DiscoveryQuery };

/**
 * `brave` — discovery of new ATS boards through Brave Search (ported from the legacy
 * `source-discovery.ts`, extended from two to five ATS). It collects no postings: each run searches
 * `site:<ats host> ("<keyword>" OR …) <city>` for every ATS x keyword group x city, keeps the results
 * that are official board URLs, and writes the boards that are not in `sources.yaml (ats_boards)` to the
 * candidate table, where `/sources` lists them. It never edits the config itself.
 * Searches over the per-run cap rotate across runs, longest-waiting first (see `shared.ts`).
 *
 * The API key is `BRAVE_SEARCH_API_KEY`; without it the channel is "not configured": it logs that and
 * does nothing (no request, no failure).
 */

export const BRAVE_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";

/** Brave's limits: a query is at most 400 characters and 50 words. */
const MAX_QUERY_CHARS = 400;
const MAX_QUERY_WORDS = 50;
/** Brave answers at most this many results per request. */
const MAX_COUNT = 20;

const responseSchema = z.looseObject({
  web: z
    .looseObject({ results: z.array(z.looseObject({ url: z.string(), title: z.string().nullable().optional() })) })
    .nullable()
    .optional(),
});

function quote(term: string): string {
  return `"${term.replaceAll('"', "").trim()}"`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

/**
 * `(site:a OR site:b) ("kw" OR "kw") "City"`: as many keywords of the group as Brave's query limits
 * allow, in the order of search.yaml. null when not even one fits.
 */
export function buildDiscoveryQuery(ats: DiscoverableAts, keywords: readonly string[], city: string): string | null {
  const hosts = searchHostsFor(ats).map((h) => `site:${h}`);
  const sites = hosts.length > 1 ? `(${hosts.join(" OR ")})` : (hosts[0] ?? "");
  const tail = quote(city);
  const used: string[] = [];
  for (const keyword of keywords.map(quote).filter((k) => k.length > 2)) {
    const candidate = [...used, keyword];
    const q = `${sites} (${candidate.join(" OR ")}) ${tail}`;
    if (q.length > MAX_QUERY_CHARS || wordCount(q) > MAX_QUERY_WORDS) break;
    used.push(keyword);
  }
  return used.length === 0 ? null : `${sites} (${used.join(" OR ")}) ${tail}`;
}

/**
 * Every ATS x keyword group x city in search.yaml order (keyword group outermost, then city, then ATS).
 * When there are more than `max_queries_per_run`, a run takes the ones that had a turn longest ago first
 * (`shared.ts`); with rotation off the cap drops whole keyword groups from the end.
 */
export function buildDiscoveryQueries(search: Pick<SearchConfig, "keyword_groups" | "locations">): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [];
  for (const [group, keywords] of Object.entries(search.keyword_groups)) {
    for (const city of search.locations) {
      for (const ats of DISCOVERABLE_ATS) {
        const q = buildDiscoveryQuery(ats, keywords, city);
        if (q !== null) queries.push({ ats, group, city, q, id: discoveryQueryId({ ats, group, city, q }) });
      }
    }
  }
  return queries;
}

export type BraveDeps = DiscoveryDeps;

export const defaultBraveDeps: BraveDeps = {
  inputs: () => ({ search: loadConfig("search"), companies: loadCompanies(), queryRotation: loadConfig("channels").collect.query_rotation }),
  store: () => createDbDiscoveryStore(getDb(), "brave"),
};

/** The new boards in one search response: official URLs only, not in `known`, once per board. */
export function boardsFromResults(body: unknown, known: ReadonlySet<string>): DiscoveredBoard[] {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new ChannelError("parse", "brave search response does not match the expected shape");
  return boardsFromHits(parsed.data.web?.results ?? [], known);
}

function braveSettingsOf(ctx: ChannelContext): BraveChannelSettings {
  const parsed = braveChannelSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) throw new ChannelError("unknown", "sources.yaml block for brave is invalid", { retryable: false });
  // An empty country follows the market
  return { ...parsed.data, country: parsed.data.country || marketForChannel().country };
}

const braveProvider: DiscoveryProvider<BraveChannelSettings> = {
  id: "brave",
  keyEnv: BRAVE_API_KEY_ENV,
  settingsOf: braveSettingsOf,
  endpoint: (settings) => ({ service: "brave", url: settings.api_base_url }),
  buildQueries: (search) => buildDiscoveryQueries(search),
  async search(query, apiKey, settings, ctx) {
    const params = new URLSearchParams({
      q: query.q,
      count: String(Math.min(settings.max_results, MAX_COUNT)),
      country: settings.country ?? "",
      safesearch: settings.safesearch,
    });
    const url = `${settings.api_base_url.replace(/\/+$/, "")}/res/v1/web/search?${params.toString()}`;
    const response = await ctx.http.request(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, redirect: "error" });
    const body: unknown = await response.json().catch((error: unknown) => {
      throw new ChannelError("parse", "brave search response is not valid JSON", { cause: error });
    });
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new ChannelError("parse", "brave search response does not match the expected shape");
    return parsed.data.web?.results ?? [];
  },
};

export function createBraveChannel(deps: BraveDeps = defaultBraveDeps): Channel {
  return createDiscoveryChannel(braveProvider, deps);
}
