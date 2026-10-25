import { z } from "zod";

import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import type { Channel, ChannelBudget, ChannelContext } from "@/lib/channels/types";
import { loadCompanies, loadConfig, tavilyChannelSchema, type SearchConfig, type TavilyChannelSettings } from "@/lib/config";
import { getDb } from "@/lib/db/client";

import { DISCOVERABLE_ATS, searchHostsFor, type DiscoverableAts } from "./boards";
import { createDiscoveryChannel, discoveryQueryId, type DiscoveryDeps, type DiscoveryProvider, type DiscoveryQuery } from "./shared";
import { createDbDiscoveryStore } from "./store";

/**
 * `tavily` — discovery of new ATS boards through the Tavily Search API, the default search
 * backend; `brave` is the alternative. Same job as `brave` (see `shared.ts`): for every ATS x keyword
 * group x city it searches, restricted to the ATS hosts with `include_domains`, and keeps the results
 * that are official board URLs. Tavily has no `site:` operator, so the query is plain words.
 * Searches over the per-run cap rotate across runs, longest-waiting first (see `shared.ts`).
 *
 * `POST {api_base_url}/search` with `Authorization: Bearer $TAVILY_API_KEY`. A search costs 1 credit
 * (2 with `search_depth: advanced`); credits are booked against `monthly_credit_limit` (the plan's
 * allowance) and, beyond it, against `monthly_budget_usd` at `credit_cost_usd` per credit.
 * Without the key the channel is "not configured": it logs that and does nothing.
 */

export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

/** Tavily answers at most this many results per request. */
const MAX_RESULTS = 20;

const responseSchema = z.looseObject({
  results: z.array(z.looseObject({ url: z.string(), title: z.string().nullable().optional() })),
  usage: z.looseObject({ credits: z.number().nonnegative().nullable().optional() }).nullable().optional(),
});

/** Credits one search costs by the Tavily docs: `advanced` 2, every other depth 1. */
export function creditsPerSearch(depth: TavilyChannelSettings["search_depth"]): number {
  return depth === "advanced" ? 2 : 1;
}

/**
 * Domains for Tavily's `include_domains`. Tavily matches a listed domain and its sub-domains, but a listed sub-domain
 * does not cover deeper ones: `jobs.personio.de` returns nothing for `acme.jobs.personio.de` boards (live check
 * 2026-10-08), so Personio is searched as `personio.de`; `boardFromUrl` still keeps only real board URLs.
 */
export function tavilyDomainsFor(ats: DiscoverableAts): string[] {
  return ats === "personio" ? ["personio.de"] : searchHostsFor(ats);
}

/** `kw1 OR kw2 jobs City` for the first `keywords_per_query` keywords of each group; the ATS hosts go to `include_domains`. */
export function buildTavilyQueries(search: Pick<SearchConfig, "keyword_groups" | "locations">, keywordsPerQuery: number): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [];
  for (const [group, keywords] of Object.entries(search.keyword_groups)) {
    const terms = keywords.map((k) => k.replaceAll('"', "").trim()).filter((k) => k !== "").slice(0, keywordsPerQuery);
    if (terms.length === 0) continue;
    for (const city of search.locations) {
      for (const ats of DISCOVERABLE_ATS) {
        const parts = { ats, group, city, q: `${terms.join(" OR ")} jobs ${city}`, domains: tavilyDomainsFor(ats) };
        queries.push({ ...parts, id: discoveryQueryId(parts) });
      }
    }
  }
  return queries;
}

/** Refuse (a `BudgetExceededError`: the cascade skips the channel, no failure) when `credits` more are not allowed. */
export function assertCreditsAllowed(budget: ChannelBudget, settings: Pick<TavilyChannelSettings, "monthly_credit_limit" | "credit_cost_usd">, credits: number): void {
  const snapshot = budget.snapshot();
  if (credits <= snapshot.freeRecordsLeft) return;
  if (settings.credit_cost_usd <= 0) {
    throw new BudgetExceededError("channel", `tavily: monthly credit limit reached (${snapshot.records} of ${settings.monthly_credit_limit} credits used)`);
  }
  if (!budget.canAfford(credits)) {
    throw new BudgetExceededError("channel", `tavily: monthly credit limit reached and the budget does not cover more paid credits (${snapshot.records} used)`);
  }
}

export interface TavilyDeps extends DiscoveryDeps {
  /** The channel's sources.yaml block, read when the price of a credit is needed (a config reload applies without re-registering). */
  settings?: () => TavilyChannelSettings;
}

export const defaultTavilyDeps: TavilyDeps = {
  inputs: () => ({ search: loadConfig("search"), companies: loadCompanies(), queryRotation: loadConfig("channels").collect.query_rotation }),
  store: () => createDbDiscoveryStore(getDb(), "tavily"),
};

function tavilySettingsOf(ctx: ChannelContext): TavilyChannelSettings {
  const parsed = tavilyChannelSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) throw new ChannelError("unknown", "sources.yaml block for tavily is invalid", { retryable: false });
  return parsed.data;
}

const tavilyProvider: DiscoveryProvider<TavilyChannelSettings> = {
  id: "tavily",
  keyEnv: TAVILY_API_KEY_ENV,
  settingsOf: tavilySettingsOf,
  endpoint: (settings) => ({ service: "tavily", url: settings.api_base_url }),
  buildQueries: (search, settings) => buildTavilyQueries(search, settings.keywords_per_query),
  async search(query, apiKey, settings, ctx) {
    const expected = creditsPerSearch(settings.search_depth);
    assertCreditsAllowed(ctx.budget, settings, expected);
    const response = await ctx.http.request(`${settings.api_base_url.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      body: JSON.stringify({
        query: query.q,
        search_depth: settings.search_depth,
        max_results: Math.min(settings.max_results, MAX_RESULTS),
        include_domains: query.domains ?? [],
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_usage: true,
      }),
      // 432 / 433: the key's or plan's credits are used up (not a rate limit): stop the run, trip the circuit
      allowStatus: [432, 433],
    });
    if (response.status === 432 || response.status === 433) {
      throw new ChannelError("rate_limited", `HTTP ${response.status} from tavily: plan or pay-as-you-go credit limit reached`, {
        status: response.status,
        retryable: false,
        tripsCircuit: true,
      });
    }
    const body: unknown = await response.json().catch((error: unknown) => {
      throw new ChannelError("parse", "tavily search response is not valid JSON", { cause: error });
    });
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new ChannelError("parse", "tavily search response does not match the expected shape");
    // book what Tavily says it charged; fall back to the documented price when the response has no usage
    await ctx.budget.consume(parsed.data.usage?.credits ?? expected, { allowOverspend: true });
    return parsed.data.results;
  },
};

/** The hits in one search response (exported for fixture tests). */
export function tavilyHits(body: unknown): Array<{ url: string; title?: string | null | undefined }> {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new ChannelError("parse", "tavily search response does not match the expected shape");
  return parsed.data.results;
}

export function createTavilyChannel(deps: TavilyDeps = defaultTavilyDeps): Channel {
  const configured = deps.settings ?? (() => loadConfig("channels").sources.tavily);
  return createDiscoveryChannel(tavilyProvider, deps, { estimateCost: (paidCredits: number) => paidCredits * configured().credit_cost_usd });
}
