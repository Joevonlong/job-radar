import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { createFixtureChannel, FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import { buildRequests, createJsearchChannel } from "@/lib/channels/jsearch";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { Channel, RawPostingInput, SearchQuery } from "@/lib/channels/types";
import type { SearchConfig } from "@/lib/config";
import { runCycle, type CycleRunResult, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { closeDb, createCycle, failOrphanedCycles, getCycle, getDb, getMonthUsage, getQueryRunHistory, listRawPostingsForChannel, listRunsForCycle, schema, type CycleKind, type RunStatus } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { addMonthUsage, upsertChannelRows } from "@/lib/db/repos/channels";
import * as rawRepo from "@/lib/db/repos/raw-postings";
import * as runRepo from "@/lib/db/repos/runs";

import { jsearchWith, MONTH, NOW, response, SEARCH_EMPTY } from "../channels/jsearch/helpers";
import { apifyConfig, ENV as APIFY_ENV, fakeApify } from "../channels/linkedin/apify/helpers";
import { collectOf, config, pinnedSearch, quietLogger } from "../cycle/helpers";

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

afterEach(() => vi.restoreAllMocks());

const atCycle = (index: number): Date => new Date(NOW.getTime() + index * 3_600_000);

/** SQL defaults use the database clock; pin history before the next cycle reads it. Same-cycle rows deliberately tie. */
async function pinRuns(result: CycleRunResult, startedAt: Date) {
  expect(result.cycleId).toBeTypeOf("number");
  await getDb().update(schema.runs).set({ startedAt }).where(eq(schema.runs.cycleId, result.cycleId as number));
  return listRunsForCycle(getDb(), result.cycleId as number);
}

/** One query per group, with no remote query or extra location. */
function searchFor(keywordGroups: Record<string, string[]>): SearchConfig {
  return { ...pinnedSearch(), keyword_groups: keywordGroups, locations: ["Test City"], remote_scope: "none" };
}

function requestQueries(queries: readonly SearchQuery[]): string[] {
  return queries.flatMap((query) => buildRequests(query, { keywords_per_query: 2 }).map((request) => request.query));
}

function fixtureCycles(search = searchFor({ a: ["alpha"], b: ["beta"], c: ["gamma"] }), collect?: Channel["collect"]) {
  const cfg = config({ search });
  const registry = new ChannelRegistry();
  const fixture = createFixtureChannel({ id: "rotation-fixture", postings: [] });
  let attempts: SearchQuery[] = [];
  let limit = Number.POSITIVE_INFINITY;
  let cycle = 0;
  registry.register({
    ...fixture,
    async collect(query, ctx) {
      attempts.push(query);
      if (attempts.length > limit) throw new ChannelError("budget_exceeded", "test: cycle allowance exhausted");
      return (collect ?? fixture.collect)(query, ctx);
    },
  }, { settings: { ...FIXTURE_SETTINGS, monthlyBudgetUsd: 10 } });
  const run = async ({ limit: allowance = Number.POSITIVE_INFINITY, kind = "manual", ...options }: RunCycleOptions & { limit?: number; kind?: CycleKind } = {}) => {
    attempts = [];
    limit = allowance;
    const now = atCycle(cycle++);
    const result = await runCycle(kind, { registry, cascades: [], config: cfg, logger: quietLogger, now: () => now, sleep: async () => {}, ...options });
    return { result, rows: await pinRuns(result, now), attempts: [...attempts] };
  };
  return { cfg, fixture, registry, run };
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
  let cycle = 0;
  const run = async (monthlyLimit: number) => {
    channels = jsearchWith({ ...settings, monthly_request_limit: monthlyLimit });
    const now = atCycle(cycle++);
    const result = await runCycle("manual", {
      registry,
      cascades: [],
      config: { ...config({ search }), channels },
      channelIds: ["jsearch"],
      logger: quietLogger,
      now: () => now,
      sleep: async () => {},
      fetch: async (requestUrl) => {
        const request = new URL(requestUrl);
        expect(request.pathname).toBe("/search");
        calls.push(request.searchParams.get("query") ?? "");
        return response(200, SEARCH_EMPTY);
      },
    });
    await pinRuns(result, now);
    return result;
  };
  return { calls, queries: buildQueries(search, "manual"), run };
}

describe("query rotation across cycles", () => {
  it.each([true, false])("serves two queries per cycle with rotation enabled = %s", async (enabled) => {
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
    const cfg = config({ search });
    cfg.channels.collect.query_rotation = enabled;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      served = [];
      const result = await runCycle("manual", { registry, cascades: [], config: cfg, logger: quietLogger, now: () => atCycle(cycle), sleep: async () => {} });
      const runs = await pinRuns(result, atCycle(cycle));
      expect(runs.filter((run) => run.status === "succeeded").map((run) => run.queryHash)).toEqual(served);
      // The refused attempt and the unit's summary both spent nothing and kept no postings.
      expect(runs.filter((run) => run.status === "skipped")).toHaveLength(2);
      expect(runs.every((run) => run.fetched === 0 && Number(run.cost) === 0)).toBe(true);
      if (!enabled) expect(runs.filter((run) => run.windowHours !== null).map((run) => run.queryHash)).toEqual(ids.slice(0, 3));
      servedByCycle.push(served);
    }

    expect(refused).toHaveLength(3);
    expect((await getMonthUsage(getDb(), MONTH)).get(fixture.id)).toEqual({ records: 0, usd: 0 });
    expect(servedByCycle[0]).toEqual(ids.slice(0, 2));
    if (enabled) {
      expect(servedByCycle[1]).toEqual(ids.slice(2, 4));
      expect(servedByCycle[2]?.[0]).toBe(ids[4]);
    } else {
      expect(servedByCycle).toEqual(Array.from({ length: 3 }, () => ids.slice(0, 2)));
      const history = await getQueryRunHistory(getDb(), { channelIds: [fixture.id], queryHashes: ids.slice(2) });
      expect(history.filter((row) => row.lastTurnAt !== null)).toEqual([]);
    }
  });

  it("serves a query last after its empty first keyword spent quota and its second was refused", async () => {
    const { calls, queries, run } = setupJsearch();
    expect(queries).toHaveLength(3);
    const first = await run(1);
    const firstRuns = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(firstRuns).toHaveLength(2);
    expect(firstRuns[0]).toMatchObject({ queryHash: queries[0]?.id, status: "skipped", fetched: 0, errorCode: "budget_exceeded" });
    expect(Number(firstRuns[0]?.cost)).toBe(0);
    expect(firstRuns[0]?.usageUnits).toBeGreaterThan(0);
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
    expect(firstRuns[0]?.usageUnits).toBe(0);
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

describe("collect rotation edge cases", () => {
  it("moves an empty Apify query to the tail after paying for its first sub-run", async () => {
    // Apify splits long keyword lists, not remote locations, into separate actor runs.
    const search = searchFor({
      long: ["platform engineering ".repeat(6).trim(), "distributed systems ".repeat(6).trim()],
      short: ["designer"],
    });
    const queries = buildQueries(search, "manual");
    const fake = fakeApify();
    const registry = new ChannelRegistry();
    registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, environment: APIFY_ENV, now: () => NOW }));
    const run = async (budget: number, cycle: number) => {
      const channels = apifyConfig((block) => {
        block.enabled = true;
        block.monthly_budget_usd = budget;
        block.price_per_1k_usd = 0.4;
        block.run_start_usd = 0.001;
        block.throttle = { min_delay_ms: 0, max_delay_ms: 0 };
      });
      const result = await runCycle("manual", {
        registry, cascades: [], config: { ...config({ search }), channels }, logger: quietLogger,
        now: () => atCycle(cycle), sleep: async () => {}, fetch: fake.fetch,
      });
      return pinRuns(result, atCycle(cycle));
    };

    // Enough for two potential items at preflight, but after one empty run's fee not enough for another run + item.
    const first = await run(0.0018, 0);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ queryHash: queries[0]!.id, status: "skipped", fetched: 0, usageUnits: 0, errorCode: "budget_exceeded", windowHours: queries[0]!.windowHours, windowExtended: false });
    expect(Number(first[0]!.cost)).toBeCloseTo(0.001, 6);
    expect(first[0]!.error).toContain("after 1 of 2 runs");
    expect(fake.requests).toHaveLength(1);
    expect((await getMonthUsage(getDb(), MONTH)).get("linkedin-apify")).toEqual({ records: 0, usd: 0.001 });

    const second = await run(1, 1);
    expect(second.map((row) => row.queryHash)).toEqual([queries[1]!.id, queries[0]!.id]);
    expect(second.every((row) => row.status === "succeeded" && row.usageUnits === 0)).toBe(true);
    expect(fake.requests).toHaveLength(4); // one short query, then both sub-runs of the long query
    expect(fake.requests[1]!.body.keywords).toBe('"designer"');
    expect(Number(second[1]!.cost)).toBeCloseTo(0.002, 6);
  });

  it("serves every query over twice as many cycles when alternate cycles refuse before any request", async () => {
    const test = fixtureCycles(searchFor({ a: ["alpha"], b: ["beta"], c: ["gamma"], d: ["delta"], e: ["epsilon"] }));
    const ids = buildQueries(test.cfg.search, "manual").map((query) => query.id);
    const served: string[] = [];
    for (let cycle = 0; cycle < 2 * ids.length; cycle += 1) {
      const allowed = cycle % 2 === 1;
      const { rows } = await test.run({ limit: allowed ? 1 : 0 });
      const turns = rows.filter((row) => row.status === "succeeded");
      expect(turns).toHaveLength(allowed ? 1 : 0);
      served.push(...turns.map((row) => row.queryHash!));
      if (!allowed) {
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "skipped" && row.fetched === 0 && row.usageUnits === 0 && Number(row.cost) === 0)).toBe(true);
        expect(rows[0]!.queryHash).toBe(ids[cycle / 2]);
      }
    }
    expect(served).toEqual(ids);
  });

  it("puts an added query first and leaves removed queries out of later cycles", async () => {
    const test = fixtureCycles();
    const first = await test.run();
    const oldIds = first.attempts.map((query) => query.id);
    test.cfg.search.keyword_groups.d = ["delta"];
    const added = buildQueries(test.cfg.search, "manual")[3]!;
    const second = await test.run();
    expect(second.attempts.map((query) => query.id)).toEqual([added.id, ...oldIds]);

    delete test.cfg.search.keyword_groups.b;
    const third = await test.run();
    expect(third.attempts.map((query) => query.id)).toEqual([oldIds[0], oldIds[2], added.id]);
    expect(third.rows.map((row) => row.queryHash)).not.toContain(oldIds[1]);
  });

  it("uses reordered config only to break ties, not to put a recent query ahead of waiting ones", async () => {
    const test = fixtureCycles();
    const ids = buildQueries(test.cfg.search, "manual").map((query) => query.id);
    await test.run({ limit: 1 });
    test.cfg.search.keyword_groups = { a: ["alpha"], c: ["gamma"], b: ["beta"] };
    const second = await test.run();
    expect(second.attempts.map((query) => query.id)).toEqual([ids[2], ids[1], ids[0]]);
    // All three now have the same explicit timestamp: the next config order decides the tie.
    test.cfg.search.keyword_groups = { b: ["beta"], a: ["alpha"], c: ["gamma"] };
    expect((await test.run()).attempts.map((query) => query.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it("treats changed keywords as a new query id and serves it first", async () => {
    const test = fixtureCycles();
    const first = await test.run();
    test.cfg.search.keyword_groups.c = ["changed keyword"];
    const changed = buildQueries(test.cfg.search, "manual")[2]!;
    expect(changed.id).not.toBe(first.attempts[2]!.id);
    const second = await test.run();
    expect(second.attempts.map((query) => query.id)).toEqual([changed.id, first.attempts[0]!.id, first.attempts[1]!.id]);
    expect(second.rows.map((row) => row.queryHash)).not.toContain(first.attempts[2]!.id);
  });

  it("advances rotation in manual and catchup cycles while keeping each requested base window", async () => {
    const test = fixtureCycles();
    test.cfg.search.window_hours = { morning: 11, evening: 7, weekend: 29 };
    const ids = buildQueries(test.cfg.search, "manual").map((query) => query.id);
    const cases = [
      { kind: "manual", window: 29 },
      { kind: "catchup", windowKind: "weekday_evening", window: 7 },
      { kind: "weekday_morning", window: 11 },
    ] as const;
    for (const [index, { window, ...options }] of cases.entries()) {
      const { result, rows, attempts } = await test.run({ ...options, limit: 1 });
      expect(rows[0]).toMatchObject({ queryHash: ids[index], status: "succeeded", windowHours: window, windowExtended: false });
      expect(attempts.every((query) => query.windowHours === window)).toBe(true);
      expect(rows.filter((row) => row.windowHours !== null).every((row) => row.windowHours === window && !row.windowExtended)).toBe(true);
      expect(collectOf(result).rotation[test.fixture.id]).toMatchObject({ maxWindowHours: window, stretched: 0, capped: 0 });
    }
  });

  it("counts an abort during a query as its turn and retains its usage and requested window", async () => {
    const controller = new AbortController();
    let cancel = true;
    const test = fixtureCycles(undefined, async (_query, ctx) => {
      if (cancel) {
        await ctx.budget.consume(2, { costUsd: 0.02 });
        controller.abort();
        ctx.signal.throwIfAborted();
      }
      return [];
    });
    const queries = buildQueries(test.cfg.search, "manual");
    const first = await test.run({ signal: controller.signal });
    expect(first.result.status).toBe("failed");
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ queryHash: queries[0]!.id, status: "failed", error: "cancelled", usageUnits: 2, windowHours: queries[0]!.windowHours, windowExtended: false });
    expect(Number(first.rows[0]!.cost)).toBeCloseTo(0.02, 6);
    cancel = false;
    const second = await test.run();
    expect(second.attempts.map((query) => query.id)).toEqual([...queries.slice(1), queries[0]!].map((query) => query.id));
  });

  it("counts an orphaned running row as a turn after the runner cleanup marks it failed", async () => {
    const test = fixtureCycles();
    const queries = buildQueries(test.cfg.search, "manual");
    const old = atCycle(-48);
    await upsertChannelRows(getDb(), [{ id: test.fixture.id, family: test.fixture.family, kind: test.fixture.kind, enabled: true }]);
    const orphan = await createCycle(getDb(), { kind: "manual", startedAt: old });
    await getDb().insert(schema.runs).values({ channelId: test.fixture.id, cycleId: orphan.id, queryHash: queries[0]!.id, startedAt: old, status: "running", windowHours: queries[0]!.windowHours });
    expect(await failOrphanedCycles(getDb(), "test: runner restarted")).toEqual({ cycles: 1, runs: 1 });
    expect(await listRunsForCycle(getDb(), orphan.id)).toEqual([expect.objectContaining({ status: "failed", startedAt: old, error: "test: runner restarted" })]);
    expect(await getQueryRunHistory(getDb(), { channelIds: [test.fixture.id], queryHashes: [queries[0]!.id] })).toEqual([
      { channelId: test.fixture.id, queryHash: queries[0]!.id, firstSeenAt: old, lastTurnAt: old, lastCoveredAt: null },
    ]);
    expect((await test.run()).attempts.map((query) => query.id)).toEqual([...queries.slice(1), queries[0]!].map((query) => query.id));
  });

  it("falls back to config order on a history read failure while still persisting successful collection", async () => {
    const test = fixtureCycles();
    await test.run({ limit: 1 });
    const logs: LogRecord[] = [];
    // Fail only the history repository call: run writes, budget state and the cycle lock still use real Postgres.
    const history = vi.spyOn(runRepo, "getQueryRunHistory").mockRejectedValueOnce(new Error("test: history read unavailable"));
    const { result, attempts, rows } = await test.run({ logger: createLogger({ sink: (record) => logs.push(record) }) });
    expect(history).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
    expect(attempts.map((query) => query.id)).toEqual(buildQueries(test.cfg.search, "manual").map((query) => query.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
    expect(collectOf(result).rotation[test.fixture.id]).toMatchObject({ historyUnavailable: true, neverRun: 0, oldestWaitHours: null, reached: 3 });
    expect(logs.filter((record) => record.message === "query history could not be read; using config order")).toHaveLength(1);
    expect(logs.find((record) => record.message === "query rotation")?.fields.reason).toBe("read_failed");
  });

  it("keeps config order and base windows on an empty database", async () => {
    const test = fixtureCycles();
    test.cfg.search.window_hours = { morning: 13, evening: 9, weekend: 31 };
    const queries = buildQueries(test.cfg.search, "manual");
    const { result, attempts, rows } = await test.run();
    expect(attempts).toEqual(queries);
    expect(rows.map((row) => [row.queryHash, row.windowHours, row.windowExtended, row.usageUnits])).toEqual(queries.map((query) => [query.id, query.windowHours, false, 0]));
    expect(collectOf(result).rotation[test.fixture.id]).toEqual({
      sortChannel: test.fixture.id, queries: 3, reached: 3, neverRun: 3,
      oldestWaitHours: null, oldestWaiting: null, stretched: 0, maxWindowHours: 31, capped: 0, historyUnavailable: false,
    });
  });

  it("persists the complete rotation summary and emits the matching query rotation log", async () => {
    const test = fixtureCycles();
    const first = await test.run({ limit: 1 });
    const oldest = first.attempts[0]!;
    const logs: LogRecord[] = [];
    const { result } = await test.run({ limit: 1, logger: createLogger({ sink: (record) => logs.push(record), now: () => atCycle(1) }) });
    const expected = {
      sortChannel: test.fixture.id, queries: 3, reached: 1, neverRun: 2, oldestWaitHours: 1,
      oldestWaiting: { id: oldest.id, keywordGroup: oldest.keywordGroup, location: oldest.location, remoteScope: null },
      stretched: 0, maxWindowHours: oldest.windowHours, capped: 0, historyUnavailable: false,
    };
    expect(collectOf(result).rotation[test.fixture.id]).toEqual(expected);
    const saved = await getCycle(getDb(), result.cycleId as number);
    expect(saved?.summaryJson).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ name: "collect", result: expect.objectContaining({ rotation: { [test.fixture.id]: expected } }) }),
    ]) });
    expect(logs.filter((record) => record.message === "query rotation")).toEqual([{
      at: atCycle(1), level: "info", message: "query rotation",
      fields: { cycle: result.cycleId, kind: "manual", unit: test.fixture.id, ...expected, notReached: 2, reason: null },
    }]);
  });

  it("writes only an empty summary row when there is no start channel, without calling history unavailable", async () => {
    const test = fixtureCycles();
    test.registry.get(test.fixture.id)!.isConfigured = () => false;
    const { result, rows, attempts } = await test.run();
    expect(attempts).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", fetched: 0, usageUnits: 0, windowHours: null, windowExtended: false });
    expect(Number(rows[0]!.cost)).toBe(0);
    expect(collectOf(result).rotation[test.fixture.id]).toEqual({
      sortChannel: null, queries: 3, reached: 0, neverRun: 0, oldestWaitHours: null,
      oldestWaiting: null, stretched: 0, maxWindowHours: null, capped: 0, historyUnavailable: false,
    });
  });
});

describe("attempt accounting columns", () => {
  const posting: RawPostingInput = { externalId: "kept", url: null, payload: { title: "Test posting" } };
  const cases = [
    { name: "succeeded", status: "succeeded", fetched: 1, stored: 1, interrupted: false, units: 2 },
    { name: "invalid records", status: "partial", fetched: 2, stored: 1, interrupted: false, units: 2 },
    { name: "interrupted partial", status: "partial", fetched: 1, stored: 1, interrupted: true, units: 2 },
    { name: "failed", status: "failed", fetched: 0, stored: 0, interrupted: false, units: 2 },
    { name: "refused before request", status: "skipped", fetched: 0, stored: 0, interrupted: false, units: 0 },
    { name: "planned budget stop", status: "skipped", fetched: 1, stored: 1, interrupted: false, units: 2 },
    { name: "write failure", status: "failed", fetched: 1, stored: 0, interrupted: false, units: 2 },
  ] as const;

  it.each(cases)("records usage and the effective window on $name", async ({ name, status, fetched, stored, interrupted, units }) => {
    if (name === "write failure") vi.spyOn(rawRepo, "upsertRawPostings").mockRejectedValueOnce(new Error("test: postings write failed"));
    const test = fixtureCycles(searchFor({ a: ["alpha"] }), async (_query, ctx) => {
      if (name === "refused before request") throw new ChannelError("budget_exceeded", "test: no request allowance");
      await ctx.budget.consume(2, { costUsd: 0.02 });
      if (name === "failed") throw new ChannelError("network", "test: request failed");
      if (name === "interrupted partial") throw new PartialCollectError([posting], new ChannelError("network", "test: later page failed"));
      if (name === "planned budget stop") throw new PartialCollectError([posting], new ChannelError("budget_exceeded", "test: next request refused"), { planned: true });
      return name === "invalid records" ? [posting, { ...posting, externalId: "" }] : [posting];
    });
    test.cfg.search.window_hours = { morning: 13, evening: 9, weekend: 31 };
    const { result, rows, attempts } = await test.run({ kind: "catchup", windowKind: "weekday_evening" });
    expect(attempts).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queryHash: attempts[0]!.id, status, fetched, usageUnits: units, interrupted, windowHours: attempts[0]!.windowHours, windowExtended: false });
    expect(rows[0]!.windowHours).toBe(9);
    expect(Number(rows[0]!.cost)).toBeCloseTo(units === 0 ? 0 : 0.02, 6);
    expect(await listRawPostingsForChannel(getDb(), test.fixture.id)).toHaveLength(stored);
    expect(rows.every((row) => !row.windowExtended)).toBe(true);
    if (status === "skipped") {
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ status: "skipped", fetched: 0, usageUnits: 0, windowHours: null, windowExtended: false });
      expect(Number(rows[1]!.cost)).toBe(0);
      expect(rows[1]!.error).toContain("no available channel");
    } else {
      expect(rows).toHaveLength(1);
    }
    if (name === "write failure") {
      expect(rows[0]!.error).toBe("could not store postings");
      expect(collectOf(result).errors).toEqual([expect.stringContaining("could not store postings")]);
    }
  });
});

describe("query run history", () => {
  const channelId = "history-fixture";
  const firstSeenAt = new Date("2026-01-01T00:00:00Z");
  const attemptAt = new Date("2026-01-02T00:00:00Z");
  const refusedAt = new Date("2026-01-03T00:00:00Z");
  const cases: { name: string; status: RunStatus; interrupted?: boolean; error?: string; fetched?: number; usageUnits?: number; cost?: number; turn: boolean; covered: boolean }[] = [
    { name: "succeeded", status: "succeeded", turn: true, covered: true },
    { name: "partial", status: "partial", turn: true, covered: true },
    { name: "interrupted", status: "partial", interrupted: true, turn: true, covered: false },
    { name: "failed", status: "failed", turn: true, covered: false },
    { name: "cancelled", status: "failed", error: "cancelled", turn: true, covered: false },
    { name: "running", status: "running", turn: true, covered: false },
    { name: "fetched", status: "skipped", fetched: 1, turn: true, covered: true },
    { name: "usage", status: "skipped", usageUnits: 1, turn: true, covered: true },
    { name: "cost", status: "skipped", cost: 0.001, turn: true, covered: true },
    { name: "refused", status: "skipped", turn: false, covered: false },
    { name: "summary", status: "skipped", error: "no available channel for fixture; 3 queries skipped", turn: false, covered: false },
  ];

  beforeEach(async () => {
    await upsertChannelRows(getDb(), [{ id: channelId, family: "ats", kind: "api", enabled: true }]);
  });

  it.each(cases)("aggregates turn and coverage separately for $name", async ({ name, turn, covered, ...attempt }) => {
    await getDb().insert(schema.runs).values([
      { channelId, queryHash: name, status: "skipped", startedAt: firstSeenAt },
      { channelId, queryHash: name, startedAt: attemptAt, ...attempt },
      { channelId, queryHash: name, status: "skipped", startedAt: refusedAt },
    ]);
    expect(await getQueryRunHistory(getDb(), { channelIds: [channelId], queryHashes: [name] })).toEqual([{
      channelId, queryHash: name, firstSeenAt,
      lastTurnAt: turn ? attemptAt : null,
      lastCoveredAt: covered ? attemptAt : null,
    }]);
  });

  it("retains earlier coverage after a newer failure and reads rows older than forty days", async () => {
    const old = new Date(NOW.getTime() - 40 * 24 * 3_600_000);
    await getDb().insert(schema.runs).values([
      { channelId, queryHash: "old", status: "succeeded", startedAt: old },
      { channelId, queryHash: "latest-failed", status: "succeeded", startedAt: firstSeenAt },
      { channelId, queryHash: "latest-failed", status: "failed", startedAt: attemptAt },
    ]);
    const rows = await getQueryRunHistory(getDb(), { channelIds: [channelId], queryHashes: ["old", "latest-failed"] });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.queryHash === "old")).toEqual({ channelId, queryHash: "old", lastTurnAt: old, lastCoveredAt: old, firstSeenAt: old });
    expect(rows.find((row) => row.queryHash === "latest-failed")).toEqual({ channelId, queryHash: "latest-failed", lastTurnAt: attemptAt, lastCoveredAt: firstSeenAt, firstSeenAt });
  });

  it("only reads the requested channels and query hashes, excluding null summary hashes", async () => {
    await upsertChannelRows(getDb(), [{ id: "outside", family: "ats", kind: "api", enabled: true }]);
    await getDb().insert(schema.runs).values([
      { channelId, queryHash: "included", status: "succeeded", startedAt: firstSeenAt },
      { channelId, queryHash: "deleted", status: "succeeded", startedAt: firstSeenAt },
      { channelId: "outside", queryHash: "included", status: "succeeded", startedAt: firstSeenAt },
      { channelId, queryHash: null, status: "skipped", startedAt: firstSeenAt },
    ]);
    expect(await getQueryRunHistory(getDb(), { channelIds: [channelId], queryHashes: ["included"] })).toEqual([
      { channelId, queryHash: "included", lastTurnAt: firstSeenAt, lastCoveredAt: firstSeenAt, firstSeenAt },
    ]);
  });

  it("does not issue SQL when either argument is empty", async () => {
    const noSql = new Proxy(getDb(), { get() { throw new Error("SQL must not run"); } });
    await expect(getQueryRunHistory(noSql, { channelIds: [], queryHashes: ["query"] })).resolves.toEqual([]);
    await expect(getQueryRunHistory(noSql, { channelIds: [channelId], queryHashes: [] })).resolves.toEqual([]);
  });
});
