import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { createFixtureChannel, FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import { buildRequests, createJsearchChannel } from "@/lib/channels/jsearch";
import { buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { SearchQuery } from "@/lib/channels/types";
import type { SearchConfig } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { addMonthUsage, upsertChannelRows } from "@/lib/db/repos/channels";

import { jsearchWith, MONTH, NOW, response, SEARCH_EMPTY } from "../channels/jsearch/helpers";
import { config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

/** One query per group, with no remote query or extra location. */
function searchFor(keywordGroups: Record<string, string[]>): SearchConfig {
  return { ...pinnedSearch(), keyword_groups: keywordGroups, locations: ["Test City"], remote_scope: "none" };
}

function requestQueries(queries: readonly SearchQuery[]): string[] {
  return queries.flatMap((query) => buildRequests(query, { keywords_per_query: 2 }).map((request) => request.query));
}

function setupJsearch() {
  const search = searchFor({
    engineering: ["Platform Engineer", "Software Engineer"],
    design: ["Product Designer", "UX Designer"],
    operations: ["Operations Analyst", "Business Analyst"],
  });
  const settings = {
    enabled: true,
    keywords_per_query: 2,
    pages_per_query: 1,
    monthly_request_limit: 1,
    overage_cost_per_request_usd: 0,
    monthly_budget_usd: 0,
    pace_requests: false,
    fetch_details: false,
    throttle: { min_delay_ms: 0, max_delay_ms: 0 },
  };
  let channels = jsearchWith(settings);
  const registry = new ChannelRegistry();
  registry.register(createJsearchChannel({ settings: () => channels.sources.jsearch, environment: { JSEARCH_API_KEY: "test-key-not-real" }, now: () => NOW }));
  const calls: string[] = [];
  const run = (monthlyLimit: number) => {
    channels = jsearchWith({ ...settings, monthly_request_limit: monthlyLimit });
    return runCycle("manual", {
      registry,
      cascades: [],
      config: { ...config({ search }), channels },
      channelIds: ["jsearch"],
      logger: quietLogger,
      now: () => NOW,
      sleep: async () => {},
      fetch: async (requestUrl) => {
        const request = new URL(requestUrl);
        expect(request.pathname).toBe("/search");
        calls.push(request.searchParams.get("query") ?? "");
        return response(200, SEARCH_EMPTY);
      },
    });
  };
  return { calls, queries: buildQueries(search, "manual"), run };
}

describe("query rotation across cycles", () => {
  it("serves the waiting tail before repeating queries when only two fit in each cycle", async () => {
    const search = searchFor({
      engineering: ["Platform Engineer"],
      design: ["Product Designer"],
      operations: ["Operations Analyst"],
      support: ["Support Specialist"],
      finance: ["Finance Analyst"],
    });
    const queries = buildQueries(search, "manual");
    expect(queries).toHaveLength(5);
    const ids = queries.map((query) => query.id);
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ id: "limited-queries", usesQueries: true, postings: [] });
    let served: string[] = [];
    const refused: string[] = [];
    registry.register({
      ...fixture,
      async collect(query, ctx) {
        if (served.length >= 2) {
          refused.push(query.id);
          throw new ChannelError("budget_exceeded", "test: no query allowance left in this cycle");
        }
        served.push(query.id);
        return fixture.collect(query, ctx);
      },
    }, { settings: FIXTURE_SETTINGS });

    const servedByCycle: string[][] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      served = [];
      const result = await runCycle("manual", { registry, cascades: [], config: config({ search }), logger: quietLogger, now: () => NOW, sleep: async () => {} });
      const runs = await listRunsForCycle(getDb(), result.cycleId as number);
      expect(runs.filter((run) => run.status === "succeeded").map((run) => run.queryHash)).toEqual(served);
      // The refused attempt and the unit's summary both spent nothing and kept no postings.
      expect(runs.filter((run) => run.status === "skipped")).toHaveLength(2);
      expect(runs.every((run) => run.fetched === 0 && Number(run.cost) === 0)).toBe(true);
      servedByCycle.push(served);
    }

    expect(refused).toHaveLength(3);
    expect((await getMonthUsage(getDb(), MONTH)).get(fixture.id)).toEqual({ records: 0, usd: 0 });
    expect(servedByCycle[0]).toEqual(ids.slice(0, 2));
    expect(servedByCycle[1]).toEqual(ids.slice(2, 4));
    expect(servedByCycle[2]?.[0]).toBe(ids[4]);
  });

  it("serves a query last after its empty first keyword spent quota and its second was refused", async () => {
    const { calls, queries, run } = setupJsearch();
    expect(queries).toHaveLength(3);
    const first = await run(1);
    const firstRuns = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(firstRuns).toHaveLength(2);
    expect(firstRuns[0]).toMatchObject({ queryHash: queries[0]?.id, status: "skipped", fetched: 0, errorCode: "budget_exceeded" });
    expect(Number(firstRuns[0]?.cost)).toBe(0);
    expect(calls).toEqual(requestQueries(queries.slice(0, 1)).slice(0, 1));
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 1, usd: 0 });

    // Restore enough quota for every keyword, retaining the first cycle's usage and run history.
    const second = await run(7);
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns).toHaveLength(3);
    expect(secondRuns.every((row) => row.status === "succeeded")).toBe(true);
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 7, usd: 0 });
    const expected = [...queries.slice(1), ...queries.slice(0, 1)];
    expect(secondRuns.map((row) => row.queryHash)).toEqual(expected.map((query) => query.id));
    expect(calls.slice(1)).toEqual(requestQueries(expected));
  });

  it("keeps a query first when its first keyword was refused before spending any quota", async () => {
    const { calls, queries, run } = setupJsearch();
    await upsertChannelRows(getDb(), [{ id: "jsearch", family: "google", kind: "api", enabled: true }]);
    await addMonthUsage(getDb(), "jsearch", MONTH, { records: 1, usd: 0 });

    const first = await run(1);
    const firstRuns = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(firstRuns).toHaveLength(2);
    expect(firstRuns[0]).toMatchObject({ queryHash: queries[0]?.id, status: "skipped", fetched: 0, errorCode: "budget_exceeded" });
    expect(Number(firstRuns[0]?.cost)).toBe(0);
    expect(calls).toEqual([]);
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 1, usd: 0 });

    const second = await run(7);
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns).toHaveLength(3);
    expect(secondRuns.every((row) => row.status === "succeeded")).toBe(true);
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 7, usd: 0 });
    expect(secondRuns.map((row) => row.queryHash)).toEqual(queries.map((query) => query.id));
    expect(calls).toEqual(requestQueries(queries));
  });
});
