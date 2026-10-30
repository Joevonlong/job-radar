import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import type { FetchLike } from "@/lib/channels/http";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { createMonidChannel } from "@/lib/channels/linkedin/monid";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listChannelStates, listRawPostingsForChannel, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { fakeApify, response } from "../channels/linkedin/apify/helpers";
import { fakeProvider } from "../channels/linkedin/brightdata/helpers";
import { config, pinnedSearch, quietLogger } from "../cycle/helpers";
import { ENV, MONID, MONTH, NOW, monidChannels, monidProvider } from "./linkedin-monid-helpers";

beforeAll(async () => {
  process.env.DATABASE_URL = inject("testDatabaseUrl");
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
afterAll(async () => { await closeDb(); });

const BRIGHT = "linkedin-brightdata";
const APIFY = "linkedin-apify";

function setup(options: { brightRecords?: number; apifyBudget?: number; monidEnv?: Record<string, string | undefined> } = {}) {
  const channels = monidChannels(options);
  const bright = fakeProvider({ records: () => [{ job_posting_id: "4385999999", url: "https://www.linkedin.com/jobs/view/4385999999",
    job_title: "Platform Engineer", company_name: "Example Systems", job_location: "Example City, Germany", job_summary: "Build tools",
    job_posted_date: "2026-10-26T08:00:00Z" }] });
  const apify = fakeApify([response(400, { error: { type: "invalid-input", message: "Invented invalid input" } })]);
  const monid = monidProvider();
  const registry = new ChannelRegistry();
  registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: { BRIGHT_DATA_API_KEY: "fake-bright-key" }, now: () => NOW, sleep: async () => {} }));
  registry.register(createApifyChannel({ actorId: () => channels.linkedin.apify.actor_id, pricePer1kUsd: () => 0.4,
    environment: { APIFY_TOKEN: "fake-apify-key" }, now: () => NOW }));
  registry.register(createMonidChannel({ pricePer1kUsd: () => 1, environment: options.monidEnv ?? ENV, now: () => NOW, sleep: async () => {} }));
  const next = registerFixtureChannel(registry, { id: "fx-next", family: "linkedin" });
  const fetch: FetchLike = (url, init) => {
    const host = new URL(url).host;
    if (host === "api.monid.ai") return monid.fetch(url, init);
    if (host === "api.apify.com") return apify.fetch(url, init);
    if (host === "api.brightdata.com") return bright.fetch(url, init);
    throw new Error("Unexpected integration request host");
  };
  const run = () => runCycle("manual", { registry, cascades: [{ family: "linkedin", order: [BRIGHT, APIFY, MONID, "fx-next"] }],
    config: { ...config({ search: pinnedSearch() }), channels }, logger: quietLogger, fetch, sleep: async () => {}, now: () => NOW });
  return { run, bright, apify, monid, next };
}

describe("LinkedIn cascade through Monid", () => {
  it("serves the remaining queries when Bright Data is exhausted and Apify has no budget", async () => {
    const { run, bright, apify, monid, next } = setup({ brightRecords: 1 });
    const result = await run();
    expect(result.status).toBe("succeeded");
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((run) => [run.channelId, run.status])).toEqual([[BRIGHT, "succeeded"], ...Array(8).fill([MONID, "succeeded"])]);
    expect(bright.count("trigger")).toBe(1);
    expect(apify.requests).toHaveLength(0);
    expect(monid.runs()).toBe(8);
    expect(next.seen).toHaveLength(0);
    expect(await listRawPostingsForChannel(getDb(), MONID)).toHaveLength(8);
    const usage = (await getMonthUsage(getDb(), MONTH)).get(MONID);
    expect(usage?.records).toBe(8);
    expect(usage?.usd).toBeCloseTo(0.016, 6);
  });

  it("serves the same query and later queries after a non-retryable Apify failure", async () => {
    const { run, apify, monid, next } = setup({ apifyBudget: 1 });
    const result = await run();
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: APIFY, status: "failed", errorCode: "unknown" });
    expect(Number(runs[0]?.cost)).toBe(0);
    expect(runs.slice(1).map((run) => [run.channelId, run.status])).toEqual(Array(9).fill([MONID, "succeeded"]));
    expect(apify.requests).toHaveLength(1);
    expect(monid.runs()).toBe(9);
    expect(next.seen).toHaveLength(0);
  });

  it("skips Monid without a key, with no failed run, usage or circuit strike", async () => {
    const { run, monid, next } = setup({ monidEnv: {} });
    const result = await run();
    expect(result.status).toBe("succeeded");
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.every((run) => run.channelId === "fx-next" && run.status === "succeeded")).toBe(true);
    expect(next.seen).toHaveLength(9);
    expect(monid.requests).toHaveLength(0);
    expect((await getMonthUsage(getDb(), MONTH)).get(MONID)).toBeUndefined();
    expect((await listChannelStates(getDb())).find((state) => state.id === MONID)).toMatchObject({ consecutiveFailures: 0, circuitState: "closed" });
  });
});
