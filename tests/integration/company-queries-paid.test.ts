import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import type { FetchLike } from "@/lib/channels/http";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import { loadConfig, writeConfig } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listChannelStates, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { channelsWith } from "../channels/helpers";
import { fakeApify, response, ENV as APIFY_ENV } from "../channels/linkedin/apify/helpers";
import { ENV as BRIGHT_ENV, MONTH, NOW, fakeProvider } from "../channels/linkedin/brightdata/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const BRIGHT = "linkedin-brightdata";
const APIFY = "linkedin-apify";
const cascade: CascadeSpec[] = [{ family: "linkedin", order: [BRIGHT, APIFY, "fx-next"] }];
const WATCHED = "Northstar Labs";

let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, jobs, companies, runs, cycles, channels restart identity cascade`);
  temp = makeTempConfig();
  await writeConfig("interests", { ...loadConfig("interests"), watched_companies: [WATCHED] });
});

afterEach(() => temp.cleanup());

afterAll(async () => {
  await closeDb();
});

const search = () => ({
  ...pinnedSearch(), keyword_groups: { a: ["alpha"] }, locations: ["Test City"], remote_scope: "none" as const, max_per_group_per_location: 2,
  watched_company_queries: { enabled: true, max_per_cycle: 1, min_interval_hours: 24, max_results: 3 },
});

/** Both paid LinkedIn channels with their own allowances; `edit` sets what each test needs. */
function channels(edit: { brightCompanyQueries: boolean; apifyEnabled: boolean; apifyCompanyQueries?: boolean }) {
  return channelsWith((raw) => {
    const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
    Object.assign(linkedin.brightdata!, { enabled: true, free_records_per_month: 100, monthly_budget_usd: 0, cost_per_1k_usd: 1.5, company_queries: edit.brightCompanyQueries });
    Object.assign(linkedin.apify!, { enabled: edit.apifyEnabled, monthly_budget_usd: 10, company_queries: edit.apifyCompanyQueries ?? true });
  });
}

const brightJobs = (limit: number) =>
  Array.from({ length: limit }, (_, i) => ({
    url: `https://www.linkedin.com/jobs/view/${9000 + i}`, job_posting_id: String(9000 + i), job_title: `Bright job ${i}`,
    company_name: WATCHED, job_location: "Berlin, Germany", job_summary: "Build things", job_posted_date: "2026-10-07T07:00:00.000Z",
  }));

function setup(options: Parameters<typeof channels>[0]) {
  const bright = fakeProvider({ records: (limit) => brightJobs(limit) });
  let next = 0;
  const apify = fakeApify([(request) => {
    const limit = Number(request.query.get("maxItems"));
    return response(201, Array.from({ length: limit }, () => {
      next += 1;
      return { id: String(4385000000 + next), url: `https://www.linkedin.com/jobs/view/${4385000000 + next}`, title: `Apify job ${next}`, companyName: WATCHED, location: "Berlin, Germany", description: "Build things", postedDate: "2026-10-07" };
    }));
  }]);
  const registry = new ChannelRegistry();
  registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: BRIGHT_ENV, now: () => NOW, sleep: async () => {} }));
  registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, actorId: () => "valig/linkedin-jobs-scraper", environment: APIFY_ENV, now: () => NOW }));
  registerFixtureChannel(registry, { id: "fx-next", family: "linkedin" });
  const fetch: FetchLike = (u, init) => (new URL(u).host === "api.apify.com" ? apify.fetch(u, init) : bright.fetch(u, init));
  const run = () => runCycle("manual", {
    registry, cascades: cascade, config: { ...config({ search: search() }), channels: channels(options) },
    logger: quietLogger, fetch, sleep: async () => {}, now: () => NOW,
  });
  return { bright, apify, run };
}

const failureStrikes = async (id: string) => (await listChannelStates(getDb())).find((s) => s.id === id)?.consecutiveFailures ?? 0;

describe("company queries on the paid LinkedIn channels", () => {
  it("serves a company query on Bright Data and counts its records against the channel's allowance", async () => {
    const { bright, apify, run } = setup({ brightCompanyQueries: true, apifyEnabled: false });
    const result = await run();
    expect(result.status).toBe("succeeded");

    const rows = await listRunsForCycle(getDb(), result.cycleId as number);
    const keywordId = buildQueries(search(), "manual")[0]!.id;
    expect(rows.map((r) => [r.channelId, r.status])).toEqual([[BRIGHT, "succeeded"], [BRIGHT, "succeeded"]]);
    const company = rows.filter((r) => r.queryHash !== keywordId);
    expect(company).toHaveLength(1);
    expect(company[0]?.usageUnits).toBeGreaterThan(0);

    // the request names the company and searches the country, not a city
    const bodies = bright.requests.filter((r) => r.path.endsWith("/trigger")).map((r) => JSON.stringify(r.body));
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes(`\\"${WATCHED}\\"`) && !b.includes("Test City"))).toBe(true);
    expect(apify.requests).toHaveLength(0);

    // every record of both queries is on the channel's monthly usage
    const usage = (await getMonthUsage(getDb(), MONTH)).get(BRIGHT);
    expect(usage?.records).toBe(rows.reduce((sum, r) => sum + r.usageUnits, 0));
    expect(await failureStrikes(BRIGHT)).toBe(0);
  });

  it("with company_queries: false on Bright Data the company query goes to Apify, with no skipped run and no strike for Bright Data", async () => {
    const { bright, apify, run } = setup({ brightCompanyQueries: false, apifyEnabled: true });
    const result = await run();
    expect(result.status).toBe("succeeded");

    const rows = await listRunsForCycle(getDb(), result.cycleId as number);
    const keywordId = buildQueries(search(), "manual")[0]!.id;
    expect(rows.filter((r) => r.channelId === BRIGHT).map((r) => r.queryHash)).toEqual([keywordId]);
    const company = rows.filter((r) => r.queryHash !== keywordId);
    expect(company.map((r) => [r.channelId, r.status])).toEqual([[APIFY, "succeeded"]]);
    expect(rows.some((r) => r.status === "skipped" || r.status === "failed")).toBe(false);
    expect(bright.count("trigger")).toBe(1);
    expect(JSON.stringify(apify.requests[0]?.body)).toContain(WATCHED);

    expect((await getMonthUsage(getDb(), MONTH)).get(APIFY)?.records).toBe(company[0]?.usageUnits);
    expect(await failureStrikes(BRIGHT)).toBe(0);
    expect(await failureStrikes(APIFY)).toBe(0);
  });

  it("with both paid channels opted out no company query is planned, so nothing is sent or struck", async () => {
    const { bright, apify, run } = setup({ brightCompanyQueries: false, apifyEnabled: true, apifyCompanyQueries: false });
    const result = await run();
    expect(result.status).toBe("succeeded");
    const rows = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(rows.map((r) => [r.channelId, r.queryHash])).toEqual([[BRIGHT, buildQueries(search(), "manual")[0]!.id]]);
    expect(bright.count("trigger")).toBe(1);
    expect(apify.requests).toHaveLength(0);
    expect(await failureStrikes(BRIGHT)).toBe(0);
  });
});
