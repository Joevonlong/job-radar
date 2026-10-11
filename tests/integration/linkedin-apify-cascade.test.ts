import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import type { FetchLike } from "@/lib/channels/http";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listChannelStates, listRawPostingsForChannel, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { channelsWith } from "../channels/helpers";
import { ENV as BRIGHT_ENV, MONTH, NOW, fakeProvider } from "../channels/linkedin/brightdata/helpers";
import { ENV as APIFY_ENV, fakeApify, response, type FakeApify } from "../channels/linkedin/apify/helpers";
import { config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const BRIGHT = "linkedin-brightdata";
const APIFY = "linkedin-apify";
const cascade: CascadeSpec[] = [{ family: "linkedin", order: [BRIGHT, APIFY, "fx-next"] }];

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

/** Bright Data with a tiny allowance: 2 free records, then $0.003 (= 2 records at $1.5 per 1000); optionally switched off. */
const channels = (options: { brightEnabled?: boolean } = {}) =>
  channelsWith((raw) => {
    const block = (raw.linkedin as Record<string, Record<string, unknown>>).brightdata;
    if (!block) throw new Error("no brightdata block");
    block.free_records_per_month = 2;
    block.monthly_budget_usd = 0.003;
    block.cost_per_1k_usd = 1.5;
    block.enabled = options.brightEnabled ?? true;
  });

/** Each actor run delivers `limit` fresh jobs (the run honours maxItems). */
function actor(extra: Partial<{ failWith: number }> = {}): FakeApify {
  let next = 0;
  return fakeApify([
    (request) => {
      if (extra.failWith !== undefined) return response(extra.failWith, { error: { type: "invalid-input", message: "bad input" } });
      const limit = Number(request.query.get("maxItems"));
      return response(
        201,
        Array.from({ length: limit }, () => {
          next += 1;
          return {
            id: String(4385000000 + next),
            url: `https://www.linkedin.com/jobs/view/${4385000000 + next}`,
            title: `Apify job ${next}`,
            companyName: "Acme GmbH",
            location: "Berlin, Germany",
            description: "Build things",
            postedDate: "2026-10-07",
          };
        }),
      );
    },
  ]);
}

function setup(options: { apify: FakeApify; apifyEnv?: Record<string, string | undefined>; brightEnv?: Record<string, string | undefined>; brightEnabled?: boolean; bright?: ReturnType<typeof fakeProvider> }) {
  const bright =
    options.bright ??
    fakeProvider({
      records: (limit) =>
        Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
          url: `https://www.linkedin.com/jobs/view/${9000 + i}`,
          job_posting_id: String(9000 + i),
          job_title: `Bright job ${i}`,
          company_name: "Acme GmbH",
          job_location: "Berlin, Germany",
          job_summary: "Build things",
          job_posted_date: "2026-10-07T07:00:00.000Z",
        })),
    });
  const registry = new ChannelRegistry();
  registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: options.brightEnv ?? BRIGHT_ENV, now: () => NOW, sleep: async () => {} }));
  registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, actorId: () => "valig/linkedin-jobs-scraper", environment: options.apifyEnv ?? APIFY_ENV, now: () => NOW }));
  const next = registerFixtureChannel(registry, { id: "fx-next", family: "linkedin" });
  const fetch: FetchLike = (u, init) => (new URL(u).host === "api.apify.com" ? options.apify.fetch(u, init) : bright.fetch(u, init));
  const run = () =>
    runCycle("manual", {
      registry,
      cascades: cascade,
      config: { ...config({ search: pinnedSearch() }), channels: channels(options.brightEnabled === undefined ? {} : { brightEnabled: options.brightEnabled }) },
      logger: quietLogger,
      fetch,
      sleep: async () => {},
      now: () => NOW,
    });
  return { next, run, bright };
}

describe("LinkedIn cascade: Bright Data -> Apify", () => {
  it("Bright Data's allowance runs out, then Apify takes over the rest of the cycle (and bills it to its own channel budget)", async () => {
    const apify = actor();
    const { next, run, bright } = setup({ apify });
    const result = await run();
    expect(result.status).toBe("succeeded");

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => [r.channelId, r.status])).toEqual([
      [BRIGHT, "succeeded"], // 2 free records
      [BRIGHT, "succeeded"], // 2 paid records = the whole Bright Data budget
      ...Array(7).fill([APIFY, "succeeded"]),
    ]);
    expect(bright.count("trigger")).toBe(2);
    expect(apify.requests).toHaveLength(7);
    expect(next.seen).toHaveLength(0); // the cascade never reached the last channel

    // every Apify run delivers 25 results (the pinned search config's max_per_group_per_location; the channel's max_results is 300)
    const apifyRuns = runs.filter((r) => r.channelId === APIFY);
    expect(apifyRuns.every((r) => r.fetched === 25 && r.newCount === 25)).toBe(true);
    // 0.001 start + 25 x 0.0004 per run
    expect(Number(apifyRuns[0]?.cost)).toBeCloseTo(0.011, 6);

    const usage = (await getMonthUsage(getDb(), MONTH)).get(APIFY);
    expect(usage?.records).toBe(7 * 25);
    expect(usage?.usd).toBeCloseTo(7 * 0.011, 6);
    expect(await listRawPostingsForChannel(getDb(), APIFY)).toHaveLength(7 * 25);

    // the next cycle: Bright Data is out for the month, Apify serves all 9 queries
    const second = await run();
    expect(second.status).toBe("succeeded");
    expect(bright.count("trigger")).toBe(2);
    expect(apify.requests).toHaveLength(7 + 9);
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns.every((r) => r.channelId === APIFY)).toBe(true);
  });

  it("without APIFY_TOKEN the cascade skips Apify without a failed run or a circuit strike", async () => {
    const apify = actor();
    const { next, run } = setup({ apify, apifyEnv: {} });
    const result = await run();
    expect(result.status).toBe("succeeded");

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.some((r) => r.channelId === APIFY)).toBe(false);
    expect(runs.filter((r) => r.channelId === "fx-next")).toHaveLength(7);
    expect(apify.requests).toHaveLength(0);
    expect(next.seen).toHaveLength(7);
    const state = (await listChannelStates(getDb())).find((s) => s.id === APIFY);
    expect(state?.consecutiveFailures ?? 0).toBe(0);
  });

  it("without BRIGHT_DATA_API_KEY the cascade skips Bright Data without a request, a failed run or a circuit strike", async () => {
    const apify = actor();
    const { run } = setup({ apify, brightEnv: {} });
    const result = await run();
    expect(result.status).toBe("succeeded");

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.some((r) => r.channelId === BRIGHT)).toBe(false);
    expect(runs.some((r) => r.status === "failed")).toBe(false);
    const state = (await listChannelStates(getDb())).find((s) => s.id === BRIGHT);
    expect(state?.consecutiveFailures ?? 0).toBe(0);
  });

  it("an actor that keeps failing is given up on for the cycle, the query goes to the next channel, and three failed cycles open the circuit", async () => {
    const apify = actor({ failWith: 400 });
    const { next, run } = setup({ apify, brightEnabled: false });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const result = await run();
      const runs = await listRunsForCycle(getDb(), result.cycleId as number);
      // one failed Apify run (no retries, nothing billed), then the same query and all later ones go to the next channel
      expect(runs[0]).toMatchObject({ channelId: APIFY, status: "failed", errorCode: "unknown" });
      expect(Number(runs[0]?.cost)).toBe(0);
      expect(runs.filter((r) => r.channelId === "fx-next")).toHaveLength(9);
      expect(apify.requests).toHaveLength(cycle);
    }
    const state = (await listChannelStates(getDb())).find((s) => s.id === APIFY);
    expect(state).toMatchObject({ circuitState: "open", consecutiveFailures: 3, lastErrorCode: "unknown" });
    expect((await getMonthUsage(getDb(), MONTH)).get(APIFY)).toBeUndefined();

    // the circuit is open: the actor is not called at all
    const fourth = await run();
    expect(apify.requests).toHaveLength(3);
    expect((await listRunsForCycle(getDb(), fourth.cycleId as number)).every((r) => r.channelId === "fx-next")).toBe(true);
    expect(next.seen.length).toBe(9 * 4);
  });

  it("when Apify's own monthly budget is used up it is skipped and the next channel takes over (budget_exceeded)", async () => {
    const apify = actor();
    // room for exactly one run of 25 results (0.011 USD) and a bit less than another run's start fee plus one result
    const tight = channelsWith((raw) => {
      const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
      (linkedin.brightdata as Record<string, unknown>).enabled = false;
      (linkedin.apify as Record<string, unknown>).monthly_budget_usd = 0.012;
    });
    const registry = new ChannelRegistry();
    registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, environment: APIFY_ENV, now: () => NOW }));
    const fx = registerFixtureChannel(registry, { id: "fx-next", family: "linkedin" });
    const result = await runCycle("manual", {
      registry,
      cascades: [{ family: "linkedin", order: [APIFY, "fx-next"] }],
      config: { ...config({ search: pinnedSearch() }), channels: tight },
      logger: quietLogger,
      fetch: apify.fetch,
      sleep: async () => {},
      now: () => NOW,
    });
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: APIFY, status: "succeeded", fetched: 25 });
    // 0.012 - 0.011 = 0.001 left: one result would fit, but not the run's start fee on top: the channel refuses before calling
    // Apify (a skipped run), the same query goes to the next channel, and Apify is not tried again this cycle
    expect(runs[1]).toMatchObject({ channelId: APIFY, status: "skipped", errorCode: "budget_exceeded" });
    expect(Number(runs[1]?.cost)).toBe(0);
    expect(runs.slice(2).every((r) => r.channelId === "fx-next")).toBe(true);
    expect(fx.seen).toHaveLength(8);
    expect(apify.requests).toHaveLength(1);
  });
});
