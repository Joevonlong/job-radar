import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listRawPostingsForChannel, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { channelsWith } from "../channels/helpers";
import { ENV, MONTH, NOW, fakeProvider, type FakeProvider } from "../channels/linkedin/brightdata/helpers";
import { config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const BRIGHT = "linkedin-brightdata";
const cascade: CascadeSpec[] = [{ family: "linkedin", order: [BRIGHT, "fx-next"] }];

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
