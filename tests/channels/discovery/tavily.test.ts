// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertCreditsAllowed,
  boardsFromHits,
  buildTavilyQueries,
  createMemoryDiscoveryStore,
  createTavilyChannel,
  creditsPerSearch,
  tavilyHits,
  type TavilyDeps,
} from "@/lib/channels/discovery";
import type { ChannelBudget } from "@/lib/channels/types";
import { configRegistry, companiesSchema } from "@/lib/config";

import { atsContext, response, routedFetch } from "../ats/helpers";
import { channelsWith, shippedSearch } from "../helpers";
import { shippedYaml } from "../../config/helpers";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../fixtures/discovery/tavily-search.json"), "utf8")) as unknown;

const companies = companiesSchema.parse({
  companies: [{ name: "Pipewerk", ats: "lever", token: "pipewerk", enabled: true }],
});

const EXPECTED_BOARDS = ["ashby:examplelabs", "greenhouse:delta", "lever:gamma", "personio:betagmbh", "smartrecruiters:EpsilonGroup"];

function deps(overrides: Partial<TavilyDeps> = {}) {
  const store = createMemoryDiscoveryStore();
  const value: TavilyDeps = {
    inputs: () => ({ search: shippedSearch(), companies }),
    store: () => store,
    environment: { TAVILY_API_KEY: "tvly-test-key-not-real" },
    ...overrides,
  };
  return { deps: value, store };
}

/** A budget with `left` free credits that books what the channel consumes. */
function creditBudget(left: number, options: { canAfford?: boolean } = {}) {
  const consumed: number[] = [];
  const budget: ChannelBudget = {
    snapshot: () => ({ month: "2026-10", records: 1000 - left, usd: 0, freeRecordsLeft: left, usdLeft: 0 }),
    canAfford: () => options.canAfford ?? false,
    consume: async (records) => {
      consumed.push(records);
      return { usd: 0, freeRecords: records, paidRecords: 0 };
    },
  };
  return { budget, consumed };
}

describe("tavily queries", () => {
  it("builds one query per ATS x keyword group x city, with the ATS hosts as include_domains", () => {
    const queries = buildTavilyQueries(shippedSearch(), 2);
    expect(queries).toHaveLength(5 * 3 * 2);
    const german = queries.find((q) => q.group === "german" && q.ats === "lever" && q.city === "München");
    expect(german?.q).toBe("KI Engineer OR KI-Entwickler jobs München");
    expect(german?.domains).toEqual(["jobs.lever.co", "jobs.eu.lever.co"]);
    // A listed sub-domain does not cover `acme.jobs.personio.de` on Tavily, so Personio is searched as personio.de
    expect(queries.find((q) => q.ats === "personio")?.domains).toEqual(["personio.de"]);
    expect(buildTavilyQueries(shippedSearch(), 1).find((q) => q.group === "german")?.q).toBe("KI Engineer jobs Berlin");
  });

  it("skips groups without usable keywords", () => {
    expect(buildTavilyQueries({ keyword_groups: { empty: [], blank: ['""', "  "] }, locations: ["Berlin"] }, 2)).toEqual([]);
  });
});

describe("tavily response", () => {
  it("keeps official boards only, once each, without the boards that are already known", () => {
    const boards = boardsFromHits(tavilyHits(fixture), new Set(["lever:pipewerk"]));
    expect(boards.map((b) => `${b.ats}:${b.token}`).sort()).toEqual(EXPECTED_BOARDS);
    expect(boards[0]).toMatchObject({ boardUrl: "https://jobs.ashbyhq.com/examplelabs", title: "Machine Learning Engineer - Example Labs" });
  });

  it("treats a response without results as a parse error", () => {
    expect(() => tavilyHits({ query: "x" })).toThrow(/expected shape/);
    expect(() => tavilyHits({ results: "x" })).toThrow(/expected shape/);
    expect(tavilyHits({ results: [] })).toEqual([]);
  });
});

describe("credits", () => {
  it("advanced search costs 2 credits, every other depth 1", () => {
    expect(creditsPerSearch("advanced")).toBe(2);
    expect(creditsPerSearch("basic")).toBe(1);
    expect(creditsPerSearch("fast")).toBe(1);
    expect(creditsPerSearch("ultra-fast")).toBe(1);
  });

  it("refuses beyond the monthly limit unless paid credits are priced and affordable", () => {
    const limit = { monthly_credit_limit: 1000 };
    expect(() => assertCreditsAllowed(creditBudget(1).budget, { ...limit, credit_cost_usd: 0 }, 1)).not.toThrow();
    expect(() => assertCreditsAllowed(creditBudget(0).budget, { ...limit, credit_cost_usd: 0 }, 1)).toThrow(/monthly credit limit reached/);
    expect(() => assertCreditsAllowed(creditBudget(0, { canAfford: true }).budget, { ...limit, credit_cost_usd: 0.008 }, 1)).not.toThrow();
    expect(() => assertCreditsAllowed(creditBudget(0).budget, { ...limit, credit_cost_usd: 0.008 }, 1)).toThrow(/does not cover/);
    expect(() => assertCreditsAllowed(creditBudget(1).budget, { ...limit, credit_cost_usd: 0 }, 2)).toThrow(/monthly credit limit reached/);
  });
});

describe("tavily channel", () => {
  const search = (answer = response(200, fixture)) => routedFetch([["api.tavily.com/search", answer]]);

  it("is 'not configured' without TAVILY_API_KEY: no request, no failure, nothing written", async () => {
    const { deps: d, store } = deps({ environment: {} });
    const { fetch, requests } = search();
    const { ctx, query, logs } = atsContext("tavily", fetch);
    expect(await createTavilyChannel(d).collect(query, ctx)).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(store.candidates.size).toBe(0);
    expect(logs.some((l) => l.message === "tavily discovery is not configured")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("tvly-");
  });

  it("an empty key counts as not configured", async () => {
    const { deps: d } = deps({ environment: { TAVILY_API_KEY: "  " } });
    const { fetch, requests } = search();
    const { ctx, query } = atsContext("tavily", fetch);
    await createTavilyChannel(d).collect(query, ctx);
    expect(requests).toHaveLength(0);
  });

  it("POSTs every query with the bearer key and include_domains, books the credits, stores the new boards", async () => {
    const { deps: d, store } = deps();
    const { fetch, requests } = search();
    const { budget, consumed } = creditBudget(1000);
    const { ctx, query, logs, sleeps } = atsContext("tavily", fetch, { budget });
    expect(await createTavilyChannel(d).collect(query, ctx)).toEqual([]);

    expect(requests).toHaveLength(30);
    expect(sleeps).toHaveLength(29);
    expect(requests[0]?.url).toBe("https://api.tavily.com/search");
    expect(requests[0]?.headers.Authorization).toBe("Bearer tvly-test-key-not-real");
    const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ search_depth: "basic", max_results: 20, include_answer: false, include_usage: true });
    expect(body.include_domains).toEqual(expect.arrayContaining(["boards.greenhouse.io"]));
    expect(String(body.query)).toContain(" jobs ");
    expect(consumed).toEqual(Array.from({ length: 30 }, () => 1));

    expect([...store.candidates.keys()].sort()).toEqual(EXPECTED_BOARDS);
    expect(store.candidates.get("lever:gamma")).toMatchObject({ region: "eu" });
    expect(store.runs).toBe(1);
    expect(logs.find((l) => l.message === "tavily discovery done")?.fields).toMatchObject({ searches: 30, failedSearches: 0, candidates: 5, newCandidates: 5 });
    expect(JSON.stringify(logs)).not.toContain("tvly-");
  });

  it("books the credits the response reports", async () => {
    const { deps: d } = deps();
    const { fetch } = search(response(200, { ...(fixture as object), usage: { credits: 2 } }));
    const { budget, consumed } = creditBudget(1000);
    const { ctx, query } = atsContext("tavily", fetch, { budget });
    await createTavilyChannel(d).collect(query, ctx);
    expect(consumed[0]).toBe(2);
  });

  it("stops without a request when the monthly credits are used up; the run is not marked", async () => {
    const { deps: d, store } = deps();
    const { fetch, requests } = search();
    const { budget } = creditBudget(0);
    const { ctx, query } = atsContext("tavily", fetch, { budget });
    await expect(createTavilyChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(requests).toHaveLength(0);
    expect(store.runs).toBe(0);
  });

  it("keeps what it found when the credits run out part-way", async () => {
    const { deps: d, store } = deps();
    const { fetch } = search();
    const { consumed, budget: inner } = creditBudget(1000);
    let left = 2;
    const budget: ChannelBudget = { ...inner, snapshot: () => ({ ...inner.snapshot(), freeRecordsLeft: left }), consume: async (n, o) => { left -= n; return inner.consume(n, o); } };
    const { ctx, query } = atsContext("tavily", fetch, { budget });
    await expect(createTavilyChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(consumed).toHaveLength(2);
    expect(store.candidates.size).toBe(5);
    expect(store.runs).toBe(0);
  });

  it("obeys max_queries_per_run and the minimum interval between runs", async () => {
    const { deps: d, store } = deps();
    const channels = configRegistry.channels.schema.parse(
      (() => {
        const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: { tavily: Record<string, unknown> } };
        raw.sources.tavily.max_queries_per_run = 3;
        return raw;
      })(),
    );
    const { budget } = creditBudget(1000);
    const first = search();
    const a = atsContext("tavily", first.fetch, { channels, budget });
    await createTavilyChannel(d).collect(a.query, a.ctx);
    expect(first.requests).toHaveLength(3);

    const second = search();
    const b = atsContext("tavily", second.fetch, { channels, budget });
    await createTavilyChannel(d).collect(b.query, b.ctx);
    expect(second.requests).toHaveLength(0);
    expect(b.logs.some((l) => l.message === "tavily discovery ran recently; skipped")).toBe(true);

    store.last = new Date(Date.now() - 25 * 3_600_000);
    const third = search();
    const c = atsContext("tavily", third.fetch, { channels, budget });
    await createTavilyChannel(d).collect(c.query, c.ctx);
    expect(third.requests).toHaveLength(3);
  });

  it("a dry run searches but writes nothing and ignores the run marker", async () => {
    const { deps: d, store } = deps();
    store.last = new Date();
    const { fetch, requests } = search();
    const { budget } = creditBudget(1000);
    const { ctx, query, logs } = atsContext("tavily", fetch, { cycleId: null, budget });
    await createTavilyChannel(d).collect(query, ctx);
    expect(requests).toHaveLength(30);
    expect(store.candidates.size).toBe(0);
    expect(logs.find((l) => l.message === "tavily discovery dry run: candidates")?.fields.boards).toHaveLength(5);
  });

  it("a rejected key (401) stops the run with auth_expired", async () => {
    const { deps: d, store } = deps();
    const { fetch, requests } = search(response(401, { detail: { error: "Unauthorized: missing or invalid API key." } }));
    const { budget } = creditBudget(1000);
    const { ctx, query } = atsContext("tavily", fetch, { budget });
    await expect(createTavilyChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "auth_expired" });
    expect(requests).toHaveLength(1);
    expect(store.runs).toBe(0);
  });

  it("the plan limit (432) and the pay-as-you-go limit (433) stop the run and trip the circuit", async () => {
    for (const status of [432, 433]) {
      const { deps: d } = deps();
      const { fetch, requests } = search(response(status, { detail: { error: "limit exceeded" } }));
      const { budget, consumed } = creditBudget(1000);
      const { ctx, query } = atsContext("tavily", fetch, { budget });
      await expect(createTavilyChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "rate_limited", tripsCircuit: true, retryable: false, status });
      expect(requests).toHaveLength(1);
      expect(consumed).toEqual([]);
    }
  });

  it("one search with an unreadable answer does not stop the others; all failing fails the run", async () => {
    const { deps: d, store } = deps();
    let calls = 0;
    const { fetch } = search();
    const flaky: typeof fetch = async (url, init) => {
      calls += 1;
      return calls === 1 ? response(200, { results: "x" }) : fetch(url, init);
    };
    const { budget } = creditBudget(1000);
    const a = atsContext("tavily", flaky, { budget });
    await createTavilyChannel(d).collect(a.query, a.ctx);
    expect(store.candidates.size).toBe(5);
    expect(a.logs.filter((l) => l.message === "tavily search failed")).toHaveLength(1);

    const broken = atsContext("tavily", routedFetch([["tavily.com", response(200, { results: 5 })]]).fetch, { budget });
    await expect(createTavilyChannel(deps().deps).collect(broken.query, broken.ctx)).rejects.toMatchObject({ code: "parse" });
  });

  it("never turns a search result into a posting", () => {
    expect(() => createTavilyChannel(deps().deps).parse(null)).toThrow(/stores no postings/);
  });

  it("prices a paid credit with credit_cost_usd from the config", () => {
    const channel = createTavilyChannel({ ...deps().deps, settings: () => configRegistry.channels.schema.parse({ ...(shippedYaml("sources.yaml") as object) }).sources.tavily });
    expect(channel.estimateCost?.(10)).toBe(0);
  });
});

describe("tavily channel: the key goes only to Tavily's own host", () => {
  const proxied = channelsWith((raw) => {
    (raw.sources as Record<string, Record<string, unknown>>).tavily!.api_base_url = "https://tavily-proxy.example";
  });

  it("refuses a changed api_base_url without the opt-in: no request, no retry", async () => {
    const { deps: d } = deps();
    const { fetch, requests } = routedFetch([["tavily-proxy.example/search", response(200, fixture)]]);
    const { ctx, query } = atsContext("tavily", fetch, { channels: proxied });
    const error = await createTavilyChannel(d).collect(query, ctx).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ name: "ChannelError", retryable: false, message: expect.stringContaining("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1") });
    expect(requests).toHaveLength(0);
  });

  it("sends to it with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 and logs a warning", async () => {
    const { deps: d } = deps({ environment: { TAVILY_API_KEY: "tvly-test-key-not-real", JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" } });
    const { fetch, requests } = routedFetch([["tavily-proxy.example/search", response(200, fixture)]]);
    const { budget } = creditBudget(1000);
    const { ctx, query, logs } = atsContext("tavily", fetch, { channels: proxied, budget });
    await createTavilyChannel(d).collect(query, ctx);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.url).toBe("https://tavily-proxy.example/search");
    expect(logs.some((l) => l.level === "warn" && l.message === "tavily: custom API endpoint")).toBe(true);
  });
});
