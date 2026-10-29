import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { createDbAtsBoardStore, createGreenhouseChannel } from "@/lib/channels/ats";
import { createFixtureChannel, FIXTURE_SETTINGS, registerFixtureChannel } from "@/lib/channels/fixture";
import { createJsearchChannel } from "@/lib/channels/jsearch";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { buildQueries, buildSweepQuery } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { RotationUnitSummary } from "@/lib/channels/rotation";
import type { Channel, ChannelRuntimeSettings, SearchQuery } from "@/lib/channels/types";
import type { SearchConfig } from "@/lib/config";
import { runCycle, type CycleRunResult, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { closeDb, getCycle, getDb, getMonthUsage, listRawPostingsForChannel, listRunsForCycle, schema, type CycleKind, type RunStatus } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { addMonthUsage, upsertChannelRows } from "@/lib/db/repos/channels";
import * as runRepo from "@/lib/db/repos/runs";

import { atsChannelsWith, company, depsWith, fixtureJson, inputs, routedFetch } from "../channels/ats/helpers";
import { channelsWith } from "../channels/helpers";
import { jsearchWith, KEY_ENV, MONTH, NOW, RECORDS, response, SEARCH_EMPTY } from "../channels/jsearch/helpers";
import { ENV as BRIGHT_ENV, fakeProvider } from "../channels/linkedin/brightdata/helpers";
import { collectOf, config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number, now = NOW) => new Date(now.getTime() - hours * HOUR);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDb();
});

function searchFor(groups: Record<string, string[]> = { engineering: ["Platform Engineer"] }): SearchConfig {
  return {
    ...pinnedSearch(), keyword_groups: groups, locations: ["Test City"], remote_scope: "none",
    max_per_group_per_location: 5, window_hours: { morning: 14, evening: 10, weekend: 24 },
  };
}

const threeQueries = () => searchFor({ a: ["alpha"], b: ["beta"], c: ["gamma"] });

function catchUpConfig(search = searchFor()) {
  const cfg = config({ search, concurrency: 1 });
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      collect: { ...cfg.channels.collect, max_catch_up_hours: 168, catch_up_tolerance_hours: 6 },
    },
  };
}

/** History uses the scenario clock explicitly; the database's current time is unrelated to it. */
async function seedHistory(channel: Channel, query: SearchQuery, hoursAgo: number, fields: {
  status?: RunStatus; fetched?: number; usageUnits?: number; interrupted?: boolean;
} = {}, now = NOW): Promise<void> {
  await upsertChannelRows(getDb(), [{ id: channel.id, family: channel.family, kind: channel.kind, enabled: true }]);
  await getDb().insert(schema.runs).values({
    channelId: channel.id, queryHash: query.id, status: "succeeded",
    startedAt: ago(hoursAgo, now), finishedAt: ago(hoursAgo, now), windowHours: query.windowHours,
    windowExtended: false, ...fields,
  });
}

function cycleId(result: CycleRunResult): number {
  if (result.cycleId === null) throw new Error("expected a persisted cycle");
  return result.cycleId;
}

const rowsOf = (result: CycleRunResult) => listRunsForCycle(getDb(), cycleId(result));

async function run(registry: ChannelRegistry, cfg: ReturnType<typeof catchUpConfig>, kind: CycleKind = "weekday_evening", options: RunCycleOptions = {}) {
  const result = await runCycle(kind, {
    registry, cascades: [], config: cfg, logger: quietLogger, now: () => NOW, sleep: async () => {},
    fetch: async () => { throw new Error("unexpected outbound request"); }, ...options,
  });
  expect(collectOf(result).errors).toEqual([]);
  return result;
}

async function expectRotation(result: CycleRunResult, unit: string, expected: Pick<RotationUnitSummary, "stretched" | "maxWindowHours" | "capped">) {
  expect(collectOf(result).rotation[unit]).toMatchObject(expected);
  const step = { name: "collect", result: { rotation: { [unit]: expected } } };
  expect(result.summary.steps.find((entry) => entry.name === "collect")).toMatchObject(step);
  if (result.cycleId !== null) {
    expect((await getCycle(getDb(), result.cycleId))?.summaryJson).toMatchObject({
      steps: expect.arrayContaining([expect.objectContaining({
        name: "collect", result: expect.objectContaining({ rotation: expect.objectContaining({ [unit]: expect.objectContaining(expected) }) }),
      })]),
    });
  }
}

describe("catch-up attempt windows", () => {
  it("keeps a real Greenhouse sweep at the base window after a 240-hour gap", async () => {
    const cfg = catchUpConfig();
    cfg.channels = {
      ...atsChannelsWith("greenhouse", (block) => {
        block.enabled = true;
        block.max_results = 10;
        block.title_prefilter = { enabled: false, include_terms: [], exclude_terms: [] };
        block.throttle = { min_delay_ms: 0, max_delay_ms: 0 };
      }),
      collect: cfg.channels.collect,
    };
    const board = company({ name: "Example Labs", ats: "greenhouse", token: "examplelabs" });
    const channel = createGreenhouseChannel(depsWith(inputs([board]), createDbAtsBoardStore(getDb())));
    const registry = new ChannelRegistry();
    registry.register(channel);
    const query = buildSweepQuery(cfg.search, "weekday_evening");
    await seedHistory(channel, query, 240);
    const { fetch, requests } = routedFetch([
      ["boards-api.greenhouse.io/v1/boards/examplelabs/jobs?content=true", response(200, fixtureJson("greenhouse-board.json"))],
    ]);

    const result = await run(registry, cfg, "weekday_evening", { fetch });

    expect(requests).toHaveLength(1);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({
      channelId: channel.id, queryHash: query.id, status: "succeeded", fetched: 6,
      windowHours: query.windowHours, windowExtended: false,
    })]);
    expect(await listRawPostingsForChannel(getDb(), channel.id)).toHaveLength(6);
    await expectRotation(result, channel.id, { stretched: 0, maxWindowHours: query.windowHours, capped: 0 });
  });

  it("keeps a new query at base and persists that window without changing its id", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    const result = await run(registry, cfg);
    expect(fixture.seen).toEqual([query]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ queryHash: query!.id, status: "succeeded", windowHours: 10, windowExtended: false })]);
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it.each([
    { gap: 1, hours: 10, stretched: 0, capped: 0 },
    { gap: 48, hours: 48, stretched: 1, capped: 0 },
    { gap: 240, hours: 168, stretched: 1, capped: 1 },
  ])("shares guest coverage from $gap hours ago while calculating each cascade attempt separately", async ({ gap, hours, stretched, capped }) => {
    const cfg = catchUpConfig(threeQueries());
    const queries = buildQueries(cfg.search, "weekday_evening");
    const registry = new ChannelRegistry();
    const paid = registerFixtureChannel(registry, {
      id: "paid-fixture", family: "linkedin", kind: "paid", postings: [], costPerRecordUsd: 0.001,
      settings: { monthlyBudgetUsd: 1 }, supportsCatchUp: () => false, failure: { code: "budget_exceeded" },
    });
    const guest = registerFixtureChannel(registry, { id: "guest-fixture", family: "linkedin", kind: "guest", postings: [] });
    // Q3 has never taken a paid turn, so it goes first even though guest already covered it.
    await seedHistory(paid, queries[0]!, 2);
    await seedHistory(paid, queries[1]!, 1);
    await seedHistory(guest, queries[2]!, gap);
    const result = await run(registry, cfg, "weekday_evening", { cascades: [{ family: "linkedin", order: [paid.id, guest.id] }] });
    expect(paid.seen.map((query) => [query.id, query.windowHours])).toEqual([[queries[2]!.id, 10]]);
    expect(guest.seen.map((query) => [query.id, query.windowHours])).toEqual([
      [queries[2]!.id, hours], [queries[0]!.id, 10], [queries[1]!.id, 10],
    ]);
    const rows = await rowsOf(result);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ channelId: paid.id, queryHash: queries[2]!.id, status: "skipped", windowHours: 10, windowExtended: false });
    expect(rows[1]).toMatchObject({ channelId: guest.id, queryHash: queries[2]!.id, status: "succeeded", windowHours: hours, windowExtended: hours > 10 });
    expect(rows.slice(2).every((row) => row.windowHours === 10 && !row.windowExtended)).toBe(true);
    await expectRotation(result, "linkedin", { stretched, maxWindowHours: hours, capped });
  });

  it("uses coverage from unselected family members", async () => {
    const cfg = catchUpConfig();
    const [query] = buildQueries(cfg.search, "weekday_evening");
    const registry = new ChannelRegistry();
    const paid = registerFixtureChannel(registry, { id: "unselected-paid", family: "linkedin", postings: [], supportsCatchUp: () => false });
    const guest = registerFixtureChannel(registry, { id: "selected-guest", family: "linkedin", postings: [] });
    await seedHistory(guest, query!, 72);
    await seedHistory(paid, query!, 1);
    const result = await run(registry, cfg, "weekday_evening", {
      cascades: [{ family: "linkedin", order: [paid.id, guest.id] }], channelIds: [guest.id],
    });
    expect(paid.seen).toEqual([]);
    expect(guest.seen.map((entry) => entry.windowHours)).toEqual([10]);
    await expectRotation(result, "linkedin", { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it("measures an always-failing query from its first appearance rather than its latest failure", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(fixture, query!, 72.2, { status: "failed" });
    await seedHistory(fixture, query!, 2, { status: "failed" });
    const result = await run(registry, cfg);
    expect(fixture.seen).toEqual([{ ...query, windowHours: 73 }]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ queryHash: query!.id, windowHours: 73, windowExtended: true })]);
    await expectRotation(result, fixture.id, { stretched: 1, maxWindowHours: 73, capped: 0 });
  });

  it("uses a budget stop with retained postings as coverage instead of stretching from the older failure", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(fixture, query!, 72, { status: "failed" });
    await seedHistory(fixture, query!, 1, { status: "skipped", fetched: 2, usageUnits: 0 });
    const result = await run(registry, cfg);
    expect(fixture.seen).toEqual([query]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: 10, windowExtended: false })]);
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it.each([false, true])("uses the replaced evening cycle's base in a catchup cycle with history = %s", async (history) => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "catchup", { windowKind: "weekday_evening" });
    if (history) await seedHistory(fixture, query!, 20);
    const result = await run(registry, cfg, "catchup", { windowKind: "weekday_evening" });
    const hours = history ? 20 : 10;
    expect(fixture.seen).toEqual([{ ...query, windowHours: hours }]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: hours, windowExtended: history })]);
    await expectRotation(result, fixture.id, { stretched: history ? 1 : 0, maxWindowHours: hours, capped: 0 });
  });

  it.each([
    { kind: "weekday_morning", windowKind: undefined }, { kind: "weekday_evening", windowKind: undefined },
    { kind: "weekend", windowKind: undefined }, { kind: "manual", windowKind: undefined },
    { kind: "catchup", windowKind: "weekday_evening" },
  ] as const)("with cap zero preserves buildQueries' entire window sequence for $kind / $windowKind", async ({ kind, windowKind }) => {
    const cfg = catchUpConfig(threeQueries());
    cfg.channels.collect.max_catch_up_hours = 0;
    const expected = buildQueries(cfg.search, kind, { windowKind });
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    // Equal history timestamps keep config order while making every query old enough to extend.
    for (const query of expected) await seedHistory(fixture, query, 240);
    const result = await run(registry, cfg, kind, { windowKind });
    expect(fixture.seen).toEqual(expected);
    expect((await rowsOf(result)).map((row) => [row.queryHash, row.windowHours, row.windowExtended]))
      .toEqual(expected.map((query) => [query.id, query.windowHours, false]));
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: expected[0]!.windowHours, capped: 0 });
  });

  it("reports a cap below base without shrinking the attempt or calling it stretched", async () => {
    const cfg = catchUpConfig();
    cfg.channels.collect.max_catch_up_hours = 5;
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(fixture, query!, 48);
    const result = await run(registry, cfg);
    expect(fixture.seen).toEqual([query]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: 10, windowExtended: false })]);
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: 10, capped: 1 });
  });

  it("counts a stretched and capped query once even when two channels attempt it", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const first = registerFixtureChannel(registry, { id: "first-guest", family: "linkedin", postings: [], failure: { code: "budget_exceeded" } });
    const next = registerFixtureChannel(registry, { id: "next-guest", family: "linkedin", postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(first, query!, 240);
    const result = await run(registry, cfg, "weekday_evening", { cascades: [{ family: "linkedin", order: [first.id, next.id] }] });
    expect(first.seen).toEqual([{ ...query, windowHours: 168 }]);
    expect(next.seen).toEqual([{ ...query, windowHours: 168 }]);
    expect((await rowsOf(result)).map((row) => [row.windowHours, row.windowExtended])).toEqual([[168, true], [168, true]]);
    await expectRotation(result, "linkedin", { stretched: 1, maxWindowHours: 168, capped: 1 });
  });

  it("evaluates capability with current config settings for every attempt and again after settings change", async () => {
    const cfg = catchUpConfig(threeQueries());
    const block = { ...cfg.channels.linkedin.guest, enabled: true, throttle: { min_delay_ms: 0, max_delay_ms: 0 }, test_catch_up: true };
    cfg.channels.linkedin.guest = block;
    const evaluated: unknown[] = [];
    const registry = new ChannelRegistry();
    const configurable = createFixtureChannel({
      id: "linkedin-guest", family: "linkedin", postings: [],
      supportsCatchUp: (settings: ChannelRuntimeSettings) => {
        evaluated.push(settings.extra.test_catch_up);
        return settings.extra.test_catch_up === true;
      },
    });
    // No registry override: the capability must receive the block from this cycle's config.
    registry.register(configurable);
    const disabled = registerFixtureChannel(registry, { id: "always-base", postings: [], supportsCatchUp: () => false });
    for (const query of buildQueries(cfg.search, "weekday_evening")) {
      await seedHistory(configurable, query, 48);
      await seedHistory(disabled, query, 48);
    }
    const first = await run(registry, cfg);
    expect(configurable.seen.map((query) => query.windowHours)).toEqual([48, 48, 48]);
    expect(disabled.seen.map((query) => query.windowHours)).toEqual([10, 10, 10]);
    await expectRotation(first, configurable.id, { stretched: 3, maxWindowHours: 48, capped: 0 });
    await expectRotation(first, disabled.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
    await getDb().update(schema.runs).set({ startedAt: NOW }).where(eq(schema.runs.cycleId, cycleId(first)));
    block.test_catch_up = false;
    const second = await run(registry, cfg, "weekday_evening", { now: () => new Date(NOW.getTime() + 48 * HOUR) });
    expect(configurable.seen.slice(3).map((query) => query.windowHours)).toEqual([10, 10, 10]);
    expect(disabled.seen.slice(3).map((query) => query.windowHours)).toEqual([10, 10, 10]);
    expect(evaluated).toEqual([true, true, true, false, false, false]);
    expect((await rowsOf(second)).every((row) => row.windowHours === 10 && !row.windowExtended)).toBe(true);
    await expectRotation(second, configurable.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it("reads the clock for each attempt rather than freezing the gap at unit start", async () => {
    const cfg = catchUpConfig(searchFor({ a: ["alpha"], b: ["beta"] }));
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ postings: [] });
    let now = NOW;
    registry.register({
      ...fixture,
      async collect(query, ctx) {
        const result = await fixture.collect(query, ctx);
        now = new Date(now.getTime() + HOUR);
        return result;
      },
    }, { settings: FIXTURE_SETTINGS });
    for (const query of buildQueries(cfg.search, "weekday_evening")) await seedHistory(fixture, query, 24);
    const result = await run(registry, cfg, "weekday_evening", { now: () => now });
    expect(fixture.seen.map((query) => query.windowHours)).toEqual([24, 25]);
    expect((await rowsOf(result)).map((row) => row.windowHours)).toEqual([24, 25]);
    await expectRotation(result, fixture.id, { stretched: 2, maxWindowHours: 25, capped: 0 });
  });

  it("keeps dry runs at base despite persisted old coverage and writes no run rows", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(fixture, query!, 240);
    const before = await getDb().select().from(schema.runs);
    const result = await run(registry, cfg, "weekday_evening", { dryRun: true, db: getDb() });
    expect(result.cycleId).toBeNull();
    expect(fixture.seen).toEqual([query]);
    expect(await getDb().select().from(schema.runs)).toEqual(before);
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it("uses base and reports unavailable history when the history read fails", async () => {
    const cfg = catchUpConfig();
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { postings: [] });
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(fixture, query!, 240);
    vi.spyOn(runRepo, "getQueryRunHistory").mockRejectedValue(new Error("test: history read failed"));
    const result = await run(registry, cfg);
    expect(fixture.seen).toEqual([query]);
    expect(collectOf(result).rotation[fixture.id]?.historyUnavailable).toBe(true);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: 10, windowExtended: false })]);
    await expectRotation(result, fixture.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });
});

function jsearchSetup(now = NOW) {
  const cfg = catchUpConfig();
  cfg.channels = {
    ...jsearchWith({
      enabled: true, max_results: 5, keywords_per_query: 1, pages_per_query: 1,
      monthly_request_limit: 200, overage_cost_per_request_usd: 0, monthly_budget_usd: 0,
      pace_requests: true, fetch_details: true, max_details_per_query: 2,
      throttle: { min_delay_ms: 0, max_delay_ms: 0 },
    }),
    collect: cfg.channels.collect,
  };
  const registry = new ChannelRegistry();
  const channel = createJsearchChannel({ settings: () => cfg.channels.sources.jsearch, environment: KEY_ENV, now: () => now });
  registry.register(channel);
  return { cfg, registry, channel };
}

describe("catch-up preserves provider spending controls", () => {
  it("widens JSearch to 3days while limiting details to the configured number of job ids", async () => {
    const { cfg, registry, channel } = jsearchSetup();
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(channel, query!, 49);
    const records = Array.from({ length: 8 }, (_, index) => ({ ...RECORDS[2], job_id: `catch-up-${index}`, job_description: null }));
    const calls: URL[] = [];
    const result = await run(registry, cfg, "weekday_evening", {
      fetch: async (requestUrl) => {
        const request = new URL(requestUrl);
        calls.push(request);
        if (request.pathname === "/search") return response(200, { status: "OK", data: records });
        expect(request.pathname).toBe("/job-details");
        return response(200, { status: "OK", data: (request.searchParams.get("job_id") ?? "").split(",").map((id) => ({ job_id: id, job_description: "Build software" })) });
      },
    });
    expect(calls.filter((call) => call.pathname === "/search").map((call) => call.searchParams.get("date_posted"))).toEqual(["3days"]);
    const details = calls.filter((call) => call.pathname === "/job-details");
    expect(details).toHaveLength(1);
    const detailIds = details.flatMap((call) => (call.searchParams.get("job_id") ?? "").split(","));
    expect(detailIds).toEqual(["catch-up-0", "catch-up-1"]);
    expect(detailIds.length).toBeLessThanOrEqual(cfg.channels.sources.jsearch.max_details_per_query);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ status: "succeeded", fetched: 5, usageUnits: 3, windowHours: 49, windowExtended: true })]);
    expect((await getMonthUsage(getDb(), MONTH)).get(channel.id)).toEqual({ records: 3, usd: 0 });
    await expectRotation(result, channel.id, { stretched: 1, maxWindowHours: 49, capped: 0 });
  });

  it("records a skipped extended attempt when JSearch's paced allowance refuses before a request", async () => {
    const { cfg, registry, channel } = jsearchSetup();
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(channel, query!, 49);
    // On day 7 of a 31-day month the paced share of 200 is 46; the monthly allowance is not exhausted.
    await addMonthUsage(getDb(), channel.id, MONTH, { records: 46, usd: 0 });
    const fetch = vi.fn(async () => response(200, SEARCH_EMPTY));
    const result = await run(registry, cfg, "weekday_evening", { fetch });
    expect(fetch).not.toHaveBeenCalled();
    const rows = await rowsOf(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "skipped", queryHash: query!.id, errorCode: "budget_exceeded", fetched: 0, usageUnits: 0, windowHours: 49, windowExtended: true });
    expect(rows[0]!.error).toContain("paced share");
    expect(rows[1]).toMatchObject({ status: "skipped", windowHours: null, windowExtended: false });
    expect((await getMonthUsage(getDb(), MONTH)).get(channel.id)).toEqual({ records: 46, usd: 0 });
    await expectRotation(result, channel.id, { stretched: 1, maxWindowHours: 49, capped: 0 });
  });

  it("keeps JSearch on today for the 24.5-hour Saturday-to-Sunday gap", async () => {
    const now = new Date("2026-10-18T09:30:00Z");
    const { cfg, registry, channel } = jsearchSetup(now);
    const [query] = buildQueries(cfg.search, "weekend");
    await seedHistory(channel, query!, 24.5, {}, now);
    const calls: URL[] = [];
    const result = await run(registry, cfg, "weekend", {
      now: () => now,
      fetch: async (requestUrl) => { calls.push(new URL(requestUrl)); return response(200, SEARCH_EMPTY); },
    });
    expect(calls.map((call) => [call.pathname, call.searchParams.get("date_posted")])).toEqual([["/search", "today"]]);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: 24, windowExtended: false })]);
    await expectRotation(result, channel.id, { stretched: 0, maxWindowHours: 24, capped: 0 });
  });

  it.each([
    { gap: 1, maxResults: 3, limit: "3" },
    { gap: 240, maxResults: 3, limit: "3" },
    { gap: 240, maxResults: 9, limit: "4" },
  ])("keeps Bright Data at base after $gap hours with limit $limit from budget and maxResults=$maxResults", async ({ gap, maxResults, limit }) => {
    const cfg = catchUpConfig();
    cfg.search.max_per_group_per_location = 20;
    cfg.channels = {
      ...channelsWith((raw) => {
        const block = (raw.linkedin as Record<string, Record<string, unknown>>).brightdata!;
        Object.assign(block, { enabled: true, max_results: maxResults, free_records_per_month: 2, monthly_budget_usd: 0.003, cost_per_1k_usd: 1.5 });
      }), collect: cfg.channels.collect,
    };
    const registry = new ChannelRegistry();
    const channel = createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: BRIGHT_ENV, now: () => NOW, sleep: async () => {} });
    registry.register(channel);
    const [query] = buildQueries(cfg.search, "weekday_evening");
    await seedHistory(channel, query!, gap);
    const provider = fakeProvider({ records: [] });
    const result = await run(registry, cfg, "weekday_evening", { fetch: provider.fetch });
    const triggers = provider.requests.filter((request) => request.path.endsWith("/trigger"));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.body).toEqual([expect.objectContaining({ time_range: "Past 24 hours" })]);
    expect(triggers[0]!.query.get("limit_per_input")).toBe(limit);
    expect(await rowsOf(result)).toEqual([expect.objectContaining({ windowHours: 10, windowExtended: false, status: "succeeded" })]);
    await expectRotation(result, channel.id, { stretched: 0, maxWindowHours: 10, capped: 0 });
  });

  it("bills an over-delivering snapshot in full after a long gap and catches up the remaining queries through guest", async () => {
    const cfg = catchUpConfig(threeQueries());
    cfg.channels = {
      ...channelsWith((raw) => {
        const block = (raw.linkedin as Record<string, Record<string, unknown>>).brightdata!;
        Object.assign(block, { enabled: true, max_results: 10, free_records_per_month: 2, monthly_budget_usd: 0.003, cost_per_1k_usd: 1.5 });
      }), collect: cfg.channels.collect,
    };
    const registry = new ChannelRegistry();
    const bright = createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: BRIGHT_ENV, now: () => NOW, sleep: async () => {} });
    registry.register(bright);
    const guest = registerFixtureChannel(registry, { id: "guest-after-budget", family: "linkedin", postings: [] });
    const queries = buildQueries(cfg.search, "weekday_evening");
    for (const query of queries) await seedHistory(bright, query, 240);
    const provider = fakeProvider({ records: Array.from({ length: 5 }, (_, index) => ({
      job_posting_id: String(9000 + index), url: `https://www.linkedin.com/jobs/view/${9000 + index}`,
      job_title: `Example job ${index}`, company_name: "Example Company", job_location: "Test City",
      job_summary: "Build software", job_posted_date: ago(1).toISOString(),
    })) });
    const options = { fetch: provider.fetch, cascades: [{ family: "linkedin" as const, order: [bright.id, guest.id] }] };
    const result = await run(registry, cfg, "weekday_evening", options);
    const rows = await rowsOf(result);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ channelId: bright.id, queryHash: queries[0]!.id, status: "succeeded", fetched: 5, newCount: 5, usageUnits: 5, windowHours: 10, windowExtended: false });
    expect(Number(rows[0]!.cost)).toBeCloseTo(0.0045, 6);
    expect(rows.slice(1).map((row) => [row.channelId, row.queryHash, row.windowHours, row.windowExtended])).toEqual(
      queries.slice(1).map((query) => [guest.id, query.id, 168, true]),
    );
    expect(guest.seen.map((query) => query.windowHours)).toEqual([168, 168]);
    expect(provider.requests[0]!.query.get("limit_per_input")).toBe("4");
    expect(provider.count("trigger")).toBe(1);
    expect((await getMonthUsage(getDb(), MONTH)).get(bright.id)).toEqual({ records: 5, usd: 0.0045 });
    expect(await listRawPostingsForChannel(getDb(), bright.id)).toHaveLength(5);
    await expectRotation(result, "linkedin", { stretched: 2, maxWindowHours: 168, capped: 2 });

    await getDb().update(schema.runs).set({ startedAt: NOW }).where(eq(schema.runs.cycleId, cycleId(result)));
    const second = await run(registry, cfg, "weekday_evening", options);
    expect(provider.count("trigger")).toBe(1);
    expect((await rowsOf(second)).map((row) => row.channelId)).toEqual([guest.id, guest.id, guest.id]);
    expect((await getMonthUsage(getDb(), MONTH)).get(bright.id)).toEqual({ records: 5, usd: 0.0045 });
  });
});

