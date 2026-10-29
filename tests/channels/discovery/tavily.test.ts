// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertCreditsAllowed,
  boardsFromHits,
  buildDiscoveryQueries,
  buildTavilyQueries,
  createMemoryDiscoveryStore,
  createTavilyChannel,
  creditsPerSearch,
  discoveryQueryId,
  mergeTurns,
  tavilyHits,
  type DiscoveryQuery,
  type TavilyDeps,
} from "@/lib/channels/discovery";
import type { ChannelBudget } from "@/lib/channels/types";
import { configRegistry, companiesSchema } from "@/lib/config";

import { atsContext, response, routedFetch, type RecordedRequest } from "../ats/helpers";
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
    inputs: () => ({ search: shippedSearch(), companies, queryRotation: true }),
    store: () => store,
    environment: { TAVILY_API_KEY: "tvly-test-key-not-real" },
    ...overrides,
  };
  return { deps: value, store };
}

function requestedQuery(request: RecordedRequest): string {
  const body = z.object({ query: z.string(), include_domains: z.array(z.string()) }).parse(JSON.parse(request.body ?? "{}"));
  return `${body.query}|${body.include_domains.join(",")}`;
}

function queryText(query: DiscoveryQuery): string {
  return `${query.q}|${(query.domains ?? []).join(",")}`;
}

function rotationSetup(overrides: Partial<TavilyDeps> = {}) {
  let t = Date.now();
  const { deps: d, store } = deps({ now: () => new Date(t), ...overrides });
  const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: { tavily: Record<string, unknown> } };
  raw.sources.tavily.max_queries_per_run = 12;
  const channels = configRegistry.channels.schema.parse(raw);
  const queries = buildTavilyQueries(d.inputs().search, channels.sources.tavily.keywords_per_query);
  const channel = createTavilyChannel(d);
  const pass = (options: Parameters<typeof atsContext>[2] = {}, answer: Parameters<typeof routedFetch>[0][number][1] = response(200, fixture)) => {
    const { fetch, requests } = routedFetch([["api.tavily.com/search", answer]]);
    const harness = atsContext("tavily", fetch, { channels, budget: creditBudget(1000).budget, ...options });
    return { ...harness, requests, collect: () => channel.collect(harness.query, harness.ctx) };
  };
  return { store, queries, pass, advance: () => { t += 25 * 3_600_000; } };
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

describe("discovery query ids and turns", () => {
  it("keeps the same id only while all identity fields stay the same", () => {
    const parts: Parameters<typeof discoveryQueryId>[0] = { ats: "lever", group: "engineering", city: "Berlin", q: "engineer jobs Berlin", domains: ["jobs.lever.co", "jobs.eu.lever.co"] };
    const id = discoveryQueryId(parts);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(discoveryQueryId({ ...parts })).toBe(id);
    for (const changed of [
      { ...parts, ats: "ashby" as const },
      { ...parts, group: "extra" },
      { ...parts, city: "München" },
      { ...parts, q: "developer jobs Berlin" },
      { ...parts, domains: ["jobs.lever.co"] },
      { ...parts, domains: ["jobs.eu.lever.co", "jobs.lever.co"] },
    ]) expect(discoveryQueryId(changed)).not.toBe(id);
    const withoutDomains = { ...parts };
    delete withoutDomains.domains;
    expect(discoveryQueryId(withoutDomains)).toBe(discoveryQueryId({ ...withoutDomains, domains: [] }));
  });

  it("gives each ATS its own id for a Tavily group and city, and every Brave query a unique id", () => {
    expect(new Set(buildTavilyQueries(shippedSearch(), 2).slice(0, 5).map((q) => q.id)).size).toBe(5);
    const brave = buildDiscoveryQueries(shippedSearch());
    expect(brave).toHaveLength(30);
    expect(new Set(brave.map((q) => q.id)).size).toBe(30);
  });

  it("changes Tavily ids only when keywords_per_query changes the query text", () => {
    const two = buildTavilyQueries(shippedSearch(), 2);
    const one = buildTavilyQueries(shippedSearch(), 1);
    const three = buildTavilyQueries(shippedSearch(), 3);
    expect(one).toHaveLength(30);
    expect(three).toHaveLength(30);
    for (const [index, query] of two.entries()) {
      expect(one[index]?.id).not.toBe(query.id);
      if (query.group === "german") expect(three[index]?.id).toBe(query.id);
      else expect(three[index]?.id).not.toBe(query.id);
    }
  });

  it("retains current queries' old turns, updates attempted ones and drops removed queries", () => {
    const all = buildTavilyQueries(shippedSearch(), 2).slice(0, 3);
    const old = new Date("2026-10-01T10:00:00.123Z");
    const now = new Date("2026-10-02T11:00:00.456Z");
    const previous = new Map([[all[0]!.id, old], [all[1]!.id, old], ["removed", old]]);
    const next = mergeTurns(all, previous, [all[1]!.id, "removed"], now);
    expect(next).toEqual(new Map([[all[0]!.id, old], [all[1]!.id, now]]));
    expect(previous.get(all[1]!.id)).toBe(old);
    expect(previous.has("removed")).toBe(true);
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

  it("declines automatic catch-up because discovery ignores the search window", () => {
    const { deps: d } = deps();
    const { ctx } = atsContext("tavily", search().fetch);
    expect(createTavilyChannel(d).supportsCatchUp?.(ctx.settings)).toBe(false);
  });

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
    const { fetch, requests } = search();
    const queries = buildTavilyQueries(d.inputs().search, 2);
    const { consumed, budget: inner } = creditBudget(1000);
    let left = 2;
    const budget: ChannelBudget = { ...inner, snapshot: () => ({ ...inner.snapshot(), freeRecordsLeft: left }), consume: async (n, o) => { left -= n; return inner.consume(n, o); } };
    const { ctx, query } = atsContext("tavily", fetch, { budget });
    await expect(createTavilyChannel(d).collect(query, ctx)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(consumed).toHaveLength(2);
    expect(store.candidates.size).toBe(5);
    expect(store.runs).toBe(0);
    expect(requests.map(requestedQuery)).toEqual(queries.slice(0, 2).map(queryText));
    expect([...store.turns.keys()]).toEqual(queries.slice(0, 2).map((q) => q.id));

    left = 1000;
    const next = search();
    const retry = atsContext("tavily", next.fetch, { budget });
    await createTavilyChannel(d).collect(retry.query, retry.ctx);
    expect(next.requests.map(requestedQuery)).toEqual([...queries.slice(2), ...queries.slice(0, 2)].map(queryText));
  });

  it("searches every query within ceil(total / max_queries_per_run) runs instead of starving the tail", async () => {
    let t = Date.now();
    const { deps: d } = deps({ now: () => new Date(t) });
    const channels = configRegistry.channels.schema.parse(
      (() => {
        const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: { tavily: Record<string, unknown> } };
        raw.sources.tavily.max_queries_per_run = 12;
        return raw;
      })(),
    );
    const queries = buildTavilyQueries(d.inputs().search, channels.sources.tavily.keywords_per_query)
      .map((q) => `${q.q}|${(q.domains ?? []).join(",")}`);
    expect(queries).toHaveLength(30);
    const { budget } = creditBudget(1000);
    const channel = createTavilyChannel(d);
    const runs: string[][] = [];
    for (let run = 0; run < Math.ceil(queries.length / channels.sources.tavily.max_queries_per_run); run += 1) {
      const { fetch, requests } = search();
      const { ctx, query, logs } = atsContext("tavily", fetch, { channels, budget });
      await channel.collect(query, ctx);
      expect(requests).toHaveLength(12);
      runs.push(requests.map(requestedQuery));
      expect(logs.find((l) => l.message === "tavily discovery done")?.fields).toMatchObject({
        searches: 12, queries: 30, capped: 18, neverRun: Math.max(0, 30 - (run + 1) * 12), rotation: true,
      });
      t += 25 * 3_600_000;
    }
    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual(queries.slice(0, 12));
    expect(runs[1]).toEqual(queries.slice(12, 24));
    expect(runs[2]).toEqual([...queries.slice(24), ...queries.slice(0, 6)]);
    expect(new Set(runs.flat())).toEqual(new Set(queries));
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
    expect(store.turnReads).toBe(0);
    expect(store.turnWrites).toBe(0);
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

describe("tavily discovery rotation", () => {
  it("keeps config order with rotation off but still records turns", async () => {
    const { store, queries, pass, advance } = rotationSetup({ inputs: () => ({ search: shippedSearch(), companies, queryRotation: false }) });
    for (let run = 0; run < 3; run += 1) {
      const current = pass();
      await current.collect();
      expect(current.requests.map(requestedQuery)).toEqual(queries.slice(0, 12).map(queryText));
      expect(current.logs.find((l) => l.message === "tavily discovery done")?.fields.rotation).toBe(false);
      advance();
    }
    expect([...store.turns.keys()]).toEqual(queries.slice(0, 12).map((q) => q.id));
    expect(store.turnWrites).toBe(3);
  });

  it("counts a quota rejection as a turn and retries from the next unattempted query", async () => {
    const { store, queries, pass } = rotationSetup();
    let calls = 0;
    const limited = pass({}, () => ++calls === 3 ? response(432, "limit exceeded") : response(200, fixture));
    await expect(limited.collect()).rejects.toMatchObject({ code: "rate_limited" });
    expect(limited.requests).toHaveLength(3);
    expect([...store.turns.keys()]).toEqual(queries.slice(0, 3).map((q) => q.id));
    expect(store.runs).toBe(0);
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual(queries.slice(3, 15).map(queryText));
  });

  it("saves turns before throwing the first failure when every selected query fails", async () => {
    const { store, queries, pass } = rotationSetup();
    const broken = pass({}, response(200, "not JSON"));
    await expect(broken.collect()).rejects.toMatchObject({ code: "parse", message: "tavily search response is not valid JSON" });
    expect(broken.requests).toHaveLength(12);
    expect([...store.turns.keys()]).toEqual(queries.slice(0, 12).map((q) => q.id));
    expect(store.turnWrites).toBe(1);
    expect(store.runs).toBe(0);
    expect(store.candidates.size).toBe(0);
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual(queries.slice(12, 24).map(queryText));
  });

  it("ties new queries with other unattempted queries in config order and prunes deleted queries", async () => {
    const search = shippedSearch();
    const { store, queries, pass, advance } = rotationSetup({ inputs: () => ({ search, companies, queryRotation: true }) });
    await pass().collect();
    delete search.keyword_groups.engineering;
    search.keyword_groups.extra = ["Extra Engineer", "Extra Developer"];
    advance();
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual(queries.slice(12, 24).map(queryText));
    for (const query of queries.filter((q) => q.group === "engineering")) expect(store.turns.has(query.id)).toBe(false);
  });

  it("serves new queries first after all earlier queries have had a turn", async () => {
    const search = shippedSearch();
    const { store, queries, pass, advance } = rotationSetup({ inputs: () => ({ search, companies, queryRotation: true }) });
    for (let run = 0; run < 3; run += 1) {
      await pass().collect();
      advance();
    }
    expect(store.turns.size).toBe(30);
    delete search.keyword_groups.engineering;
    search.keyword_groups.extra = ["Extra Engineer", "Extra Developer"];
    const extra = buildTavilyQueries(search, 2).filter((q) => q.group === "extra");
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual([...extra, ...queries.slice(10, 12)].map(queryText));
    for (const query of queries.filter((q) => q.group === "engineering")) expect(store.turns.has(query.id)).toBe(false);
  });

  it("preserves ids and turns when cities are reordered and follows the new order for ties", async () => {
    const search = shippedSearch();
    const { store, queries, pass, advance } = rotationSetup({ inputs: () => ({ search, companies, queryRotation: true }) });
    await pass().collect();
    const previous = new Map(store.turns);
    search.locations.reverse();
    expect(new Set(buildTavilyQueries(search, 2).map((q) => q.id))).toEqual(new Set(queries.map((q) => q.id)));
    advance();
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual([...queries.slice(15, 20), ...queries.slice(12, 15), ...queries.slice(25, 29)].map(queryText));
    for (const query of queries.slice(0, 12)) expect(store.turns.get(query.id)).toEqual(previous.get(query.id));
  });

  it("uses config order for dry runs and the test button without reading or writing turns", async () => {
    const { store, queries, pass } = rotationSetup();
    const history = new Map(queries.map((q, index) => [q.id, new Date(Date.now() - index * 3_600_000)]));
    store.turns = new Map(history);
    const dry = pass({ cycleId: null });
    await dry.collect();
    expect(dry.requests.map(requestedQuery)).toEqual(queries.slice(0, 12).map(queryText));
    expect(store.turnReads).toBe(0);
    expect(store.turnWrites).toBe(0);
    expect(store.turns).toEqual(history);
    expect(store.runs).toBe(0);
    expect(dry.logs.find((l) => l.message === "tavily discovery done")?.fields).toMatchObject({ neverRun: null, rotation: false });
  });

  it("writes nothing when cancelled part-way and selects the same batch next time", async () => {
    const { store, queries, pass } = rotationSetup();
    const history = new Map(queries.slice(0, 6).map((q) => [q.id, new Date("2026-10-01T00:00:00Z")]));
    store.turns = new Map(history);
    const controller = new AbortController();
    let calls = 0;
    // atsContext disables retries; cancellation is triggered by the third fetch, never a timer.
    const cancelled = pass({ signal: controller.signal }, () => {
      if (++calls === 3) {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }
      return response(200, fixture);
    });
    await expect(cancelled.collect()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.requests.map(requestedQuery)).toEqual(queries.slice(6, 9).map(queryText));
    expect(store.turnWrites).toBe(0);
    expect(store.turns).toEqual(history);
    expect(store.candidates.size).toBe(0);
    expect(store.runs).toBe(0);
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual(queries.slice(6, 18).map(queryText));
  });

  it("writes nothing when the final successful search returns after cancellation", async () => {
    const { store, queries, pass } = rotationSetup();
    const controller = new AbortController();
    const { budget: inner, consumed } = creditBudget(1000);
    const budget: ChannelBudget = { ...inner, consume: async (n, options) => {
      const usage = await inner.consume(n, options);
      if (consumed.length === 12) controller.abort();
      return usage;
    } };
    const cancelled = pass({ signal: controller.signal, budget });
    await expect(cancelled.collect()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.requests.map(requestedQuery)).toEqual(queries.slice(0, 12).map(queryText));
    expect(consumed).toHaveLength(12);
    expect(store.turnWrites).toBe(0);
    expect(store.turns.size).toBe(0);
    expect(store.candidates.size).toBe(0);
    expect(store.runs).toBe(0);
    const next = pass();
    await next.collect();
    expect(next.requests.map(requestedQuery)).toEqual(cancelled.requests.map(requestedQuery));
  });

  it("only warns if saving turns fails, after saving candidates and before marking the run", async () => {
    const { store, pass } = rotationSetup();
    const writes: string[] = [];
    const { upsert, markRun } = store;
    store.upsert = async (items) => { writes.push("candidates"); return upsert(items); };
    store.saveTurns = async () => { writes.push("turns"); throw new Error("turn write unavailable"); };
    store.markRun = async () => { writes.push("run"); await markRun(); };
    const current = pass();
    await expect(current.collect()).resolves.toEqual([]);
    expect(writes).toEqual(["candidates", "turns", "run"]);
    expect(store.candidates.size).toBe(5);
    expect(store.runs).toBe(1);
    expect(current.logs.filter((l) => l.level === "warn" && l.message === "tavily discovery turns could not be saved")).toHaveLength(1);
    expect(current.logs.find((l) => l.message === "tavily discovery done")?.fields.neverRun).toBeNull();
  });

  it("only warns if reading turns fails and leaves the stored history untouched", async () => {
    const { store, queries, pass } = rotationSetup();
    const history = new Map(queries.slice(0, 12).map((q) => [q.id, new Date("2026-10-01T00:00:00Z")]));
    store.turns = new Map(history);
    store.lastTurns = async () => { throw new Error("turn read unavailable"); };
    const current = pass();
    await expect(current.collect()).resolves.toEqual([]);
    expect(current.requests.map(requestedQuery)).toEqual(queries.slice(0, 12).map(queryText));
    expect(store.turnWrites).toBe(0);
    expect(store.turns).toEqual(history);
    expect(store.runs).toBe(1);
    expect(current.logs.filter((l) => l.level === "warn" && l.message === "tavily discovery turns could not be read; using config order")).toHaveLength(1);
    expect(current.logs.find((l) => l.message === "tavily discovery done")?.fields).toMatchObject({ rotation: false, neverRun: null });
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
