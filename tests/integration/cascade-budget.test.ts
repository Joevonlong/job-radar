import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listRawPostingsForChannel, listRunsForCycle, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { channelsWith } from "../channels/helpers";
import { ENV, MONTH, NOW, fakeProvider, type FakeProvider } from "../channels/linkedin/brightdata/helpers";
import { ENV as APIFY_ENV } from "../channels/linkedin/apify/helpers";
import { collectOf, config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const BRIGHT = "linkedin-brightdata";
const cascade: CascadeSpec[] = [{ family: "linkedin", order: [BRIGHT, "fx-next"] }];

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

/** Bright Data with a tiny allowance: 2 free records, then $0.003 (= 2 records at $1.5 per 1000). */
const tinyBudget = () =>
  channelsWith((raw) => {
    const block = (raw.linkedin as Record<string, Record<string, unknown>>).brightdata;
    if (!block) throw new Error("no brightdata block");
    block.free_records_per_month = 2;
    block.monthly_budget_usd = 0.003;
    block.cost_per_1k_usd = 1.5;
  });

/** Each snapshot delivers `perSnapshot(limit)` fresh jobs. */
function provider(perSnapshot: (limit: number) => number): FakeProvider {
  let next = 0;
  return fakeProvider({
    records: (limit) =>
      Array.from({ length: perSnapshot(limit) }, () => {
        next += 1;
        return {
          url: `https://www.linkedin.com/jobs/view/${9000 + next}`,
          job_posting_id: String(9000 + next),
          job_title: `Job ${next}`,
          company_name: "Acme GmbH",
          job_location: "Berlin, Germany",
          job_summary: "Build things",
          job_posted_date: "2026-10-07T07:00:00.000Z",
        };
      }),
  });
}

function setup(fake: FakeProvider) {
  const registry = new ChannelRegistry();
  registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: ENV, now: () => NOW, sleep: async () => {} }));
  const next = registerFixtureChannel(registry, { id: "fx-next", family: "linkedin" });
  const run = () =>
    runCycle("manual", {
      registry,
      cascades: cascade,
      config: { ...config({ search: pinnedSearch() }), channels: tinyBudget() },
      logger: quietLogger,
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => NOW,
    });
  return { next, run };
}

describe("Bright Data budget -> LinkedIn cascade", () => {
  it("a guest-only backfill creates no paid run rows or paid usage", async () => {
    const registry = new ChannelRegistry();
    const paid = [BRIGHT, "linkedin-apify", "jsearch"].map((id) => registerFixtureChannel(registry, {
      id, family: id === "jsearch" ? "google" : "linkedin", kind: "paid", postings: [],
      costPerRecordUsd: 0.01, settings: { monthlyBudgetUsd: 10 },
    }));
    const guest = registerFixtureChannel(registry, { id: "linkedin-guest", family: "linkedin", kind: "guest", postings: [] });
    const cfg = config({ search: {
      ...pinnedSearch(), keyword_groups: { engineering: ["Platform Engineer"] },
      locations: ["Test City"], remote_scope: "none", window_hours: { morning: 24, evening: 24, weekend: 24 },
    } });
    const result = await runCycle("manual", {
      registry, cascades: [{ family: "linkedin", order: [BRIGHT, "linkedin-apify", guest.id] }], config: cfg,
      channelIds: [guest.id], backfillHours: 36, logger: quietLogger, now: () => NOW, sleep: async () => {},
      fetch: async () => { throw new Error("unexpected outbound request"); },
    });
    expect(result.status).toBe("succeeded");
    expect(await listRunsForCycle(getDb(), result.cycleId as number)).toEqual([expect.objectContaining({ channelId: guest.id, windowHours: 36, windowExtended: true })]);
    const usage = await getMonthUsage(getDb(), MONTH);
    for (const channel of paid) {
      expect(channel.seen).toEqual([]);
      expect(usage.has(channel.id)).toBe(false);
    }
    expect(guest.seen).toHaveLength(1);
  });

  it("rotates Bright Data's one-query allowance, then follows the guest's own history when it starts", async () => {
    const guestId = "linkedin-guest";
    const apifyId = "linkedin-apify";
    const search = {
      ...pinnedSearch(), keyword_groups: { a: ["alpha"], b: ["beta"], c: ["gamma"] },
      locations: ["Test City"], remote_scope: "none" as const, max_per_group_per_location: 1,
    };
    const ids = buildQueries(search, "manual").map((query) => query.id);
    const fake = provider(() => 1);
    const registry = new ChannelRegistry();
    registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: ENV, now: () => NOW, sleep: async () => {} }));
    registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, environment: APIFY_ENV, now: () => NOW }));
    const guest = registerFixtureChannel(registry, { id: guestId, family: "linkedin", postings: [] });
    const run = async (cycle: number, allowance: number, channelIds?: readonly string[]) => {
      const now = new Date(NOW.getTime() + cycle * 3_600_000);
      const channels = channelsWith((raw) => {
        const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
        Object.assign(linkedin.brightdata!, { enabled: true, free_records_per_month: 0, monthly_budget_usd: allowance * 0.0015, cost_per_1k_usd: 1.5 });
        linkedin.apify!.enabled = false;
      });
      const result = await runCycle("manual", {
        registry, cascades: [{ family: "linkedin", order: [BRIGHT, apifyId, guestId] }],
        config: { ...config({ search }), channels }, logger: quietLogger, fetch: fake.fetch,
        sleep: async () => {}, now: () => now, ...(channelIds ? { channelIds } : {}),
      });
      // Equal timestamps within each cycle make ties explicit; later cycles are strictly newer.
      await getDb().update(schema.runs).set({ startedAt: now }).where(eq(schema.runs.cycleId, result.cycleId as number));
      return { result, rows: await listRunsForCycle(getDb(), result.cycleId as number) };
    };

    const brightQueries: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const { result, rows } = await run(cycle, cycle + 1);
      expect(result.status).toBe("succeeded");
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.channelId)).toEqual([BRIGHT, guestId, guestId]);
      expect(rows.every((row) => row.status === "succeeded")).toBe(true);
      expect(rows[0]).toMatchObject({ queryHash: ids[cycle], fetched: 1, usageUnits: 1, windowExtended: false });
      expect(Number(rows[0]!.cost)).toBeCloseTo(0.0015, 6);
      expect(collectOf(result).rotation.linkedin).toMatchObject({ sortChannel: BRIGHT, queries: 3, reached: 3, historyUnavailable: false });
      brightQueries.push(rows[0]!.queryHash!);
    }
    expect(brightQueries).toEqual(ids);
    expect(new Set(brightQueries).size).toBe(3);
    expect(fake.count("trigger")).toBe(3);
    expect(guest.seen).toHaveLength(6);

    // No allowance increase: the month is spent. Guest last served q3 a cycle before q1/q2.
    const exhausted = await run(3, 3);
    expect(exhausted.rows.map((row) => row.channelId)).toEqual([guestId, guestId, guestId]);
    expect(exhausted.rows.map((row) => row.queryHash)).toEqual([ids[2], ids[0], ids[1]]);
    expect(collectOf(exhausted.result).rotation.linkedin).toMatchObject({ sortChannel: guestId, neverRun: 0, oldestWaitHours: 2 });
    expect(fake.count("trigger")).toBe(3);

    // Even with Bright Data affordable again, a guest-only selection starts at the guest.
    const selected = await run(4, 4, [guestId]);
    expect(selected.rows.map((row) => row.channelId)).toEqual([guestId, guestId, guestId]);
    expect(selected.rows.map((row) => row.queryHash)).toEqual(ids);
    expect(collectOf(selected.result).rotation.linkedin).toMatchObject({ sortChannel: guestId, reached: 3, historyUnavailable: false });
    expect(fake.count("trigger")).toBe(3);
  });

  it("serves queries until free records and paid budget are used up, then the next channel takes the rest of the cycle", async () => {
    const fake = provider((limit) => Math.min(limit, 2));
    const { next, run } = setup(fake);
    const result = await run();

    expect(result.status).toBe("succeeded");
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => [r.channelId, r.status])).toEqual([
      [BRIGHT, "succeeded"], // 2 free records
      [BRIGHT, "succeeded"], // 2 paid records = $0.003 = the whole channel budget
      ...Array(7).fill(["fx-next", "succeeded"]),
    ]);
    expect(runs[0]).toMatchObject({ fetched: 2, newCount: 2 });
    expect(Number(runs[0]?.cost)).toBe(0);
    expect(Number(runs[1]?.cost)).toBeCloseTo(0.003, 6);
    // the remaining 7 queries (not repeats of the first two) went to the fake channel
    expect(new Set(next.seen.map((q) => q.id)).size).toBe(7);
    expect(fake.count("trigger")).toBe(2);

    const usage = (await getMonthUsage(getDb(), MONTH)).get(BRIGHT);
    expect(usage?.records).toBe(4);
    expect(usage?.usd).toBeCloseTo(0.003, 6);
    expect(await listRawPostingsForChannel(getDb(), BRIGHT)).toHaveLength(4);

    // next cycle: Bright Data is out of budget, so it is not even called
    const second = await run();
    expect(second.status).toBe("succeeded");
    expect(fake.count("trigger")).toBe(2);
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns.every((r) => r.channelId === "fx-next")).toBe(true);
    expect(secondRuns).toHaveLength(9);
  });

  it("a snapshot that exceeds the budget is stored and billed in full, then the channel is out and the next one takes over", async () => {
    // a provider that ignores limit_per_input and delivers 5 records: 2 free + 3 paid = $0.0045 > the $0.003 budget
    const fake = provider(() => 5);
    const { next, run } = setup(fake);
    const result = await run();

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: BRIGHT, status: "succeeded", fetched: 5, newCount: 5 });
    expect(Number(runs[0]?.cost)).toBeCloseTo(0.0045, 6);
    // the first query was served by Bright Data; every later one went to the next channel
    expect(runs.slice(1).map((r) => [r.channelId, r.status])).toEqual(Array(8).fill(["fx-next", "succeeded"]));
    expect(next.seen).toHaveLength(8);
    expect(next.seen.map((q) => q.id)).not.toContain(runs[0]?.queryHash);
    expect(fake.count("trigger")).toBe(1);

    // billed usage is recorded as delivered, and the paid-for records are stored
    const usage = (await getMonthUsage(getDb(), MONTH)).get(BRIGHT);
    expect(usage?.records).toBe(5);
    expect(usage?.usd).toBeCloseTo(0.0045, 6);
    expect(await listRawPostingsForChannel(getDb(), BRIGHT)).toHaveLength(5);

    // the channel stays out for the rest of the month: the next cycle never calls it
    const second = await run();
    expect(fake.count("trigger")).toBe(1);
    expect((await listRunsForCycle(getDb(), second.cycleId as number)).every((r) => r.channelId === "fx-next")).toBe(true);
    expect((await getMonthUsage(getDb(), MONTH)).get(BRIGHT)?.records).toBe(5);
  });
});
