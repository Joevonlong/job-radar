import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countJobList, getDb, getInsightsData, schema, type InsightsOptions, type InsightsWindow } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getFilterStats, getDailyCounts } from "@/lib/db/repos/insights";
import { loadInsightsView } from "@/lib/insights/load";
import { buildInsightsView } from "@/lib/insights/view";
import { insightsSchema } from "@/lib/config/schemas/insights";

import { makeTempConfig, shippedYaml, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const window: InsightsWindow = { from: "2026-10-01", to: "2026-10-07", timezone: TZ };
const previous: InsightsWindow = { from: "2026-09-24", to: "2026-09-30", timezone: TZ };
const options: InsightsOptions = {
  window,
  previous,
  cities: ["Berlin", "München"],
  pushMinScore: 70,
  topFilterReasons: 5,
  scoreBucketWidth: 5,
  scoreBucketCap: 100,
  salaryBucketEur: 10_000,
  salaryBucketCapEur: 150_000,
  salaryMinSample: 2,
  // The high-value rule and the categories of the signal card (the default ones)
  highValue: { amountId: "T1", amountHighValue: true, otherIds: ["T2"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 },
  signalCategoryIds: ["T1", "T2", "T3", "T4"],
};

const eur = (min: number, max: number, quality: "valid" | "review" = "valid") => ({
  raw: `${min}-${max}`,
  currency: "EUR",
  period: "year",
  min,
  max,
  perYear: { min, max },
  eurPerYear: { min, max },
  periodAssumed: false,
  origin: "text",
  qualityStatus: quality,
  reasonCodes: [],
});

let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

// The week is seeded again before every test (the database is emptied before each one).
beforeEach(async () => {
  await seedInsights();
});

afterAll(async () => {
  await closeDb();
});

/**
 * Seeded week (Europe/Berlin, window 2026-10-01 .. 2026-10-07, previous 2026-09-24 .. 2026-09-30):
 *
 *   J1  10-07 00:30 Berlin (= 10-06 22:30 UTC)  passed  rank 82  Berlin  linkedin          EUR 60-80k   T1
 *   J2  10-07 10:00                             passed  rank 55  München hybrid linkedin+ats            T3
 *   J3  10-06                                   filtered remote  stepstone  [location_not_allowed:Paris, contract_excluded:freelance]
 *   J4  10-06                                   passed  rank 91  Berlin+München  ats      salary text only  T2
 *   J9  10-05                                   passed  rank 60  remote  stepstone        EUR 50-60k flagged for review
 *   J5  10-03                                   passed  unscored Hamburg  linkedin        EUR 200-240k
 *   J6  10-02                                   filtered linkedin [location_not_allowed:Rome]
 *   J7  09-30 22:00 Berlin / J8 09-25           previous window
 */
async function seedInsights(): Promise<void> {
  const db = getDb();
  await db.execute(sql`truncate table jobs, companies, raw_postings, channels, applications restart identity cascade`);
  await db.insert(schema.channels).values([
    { id: "linkedin-guest", family: "linkedin", kind: "guest" },
    { id: "greenhouse", family: "ats", kind: "ats" },
    { id: "stepstone", family: "stepstone", kind: "api" },
  ]);
  const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).returning();
  const companyId = company!.id;

  const place = (city: string, isPrimary = true) => ({ label: `${city}, Germany`, city, countryCode: "DE", isPrimary });
  const defs: Array<{
    key: string;
    seen: string;
    locations: unknown[];
    workplace: "onsite" | "hybrid" | "remote";
    salary: unknown;
    sources: string[];
    score: { result: "passed" | "filtered_out"; rank: number | null; reasons?: string[] } | null;
    signal?: "T1" | "T2" | "T3";
  }> = [
    { key: "J1", seen: "2026-10-06T22:30:00Z", locations: [place("Berlin")], workplace: "onsite", salary: eur(60_000, 80_000), sources: ["linkedin-guest"], score: { result: "passed", rank: 82 }, signal: "T1" },
    { key: "J2", seen: "2026-10-07T08:00:00Z", locations: [place("München")], workplace: "hybrid", salary: null, sources: ["linkedin-guest", "greenhouse"], score: { result: "passed", rank: 55 }, signal: "T3" },
    { key: "J3", seen: "2026-10-06T09:00:00Z", locations: [], workplace: "remote", salary: null, sources: ["stepstone"], score: { result: "filtered_out", rank: null, reasons: ["location_not_allowed:Paris", "contract_excluded:freelance"] } },
    { key: "J4", seen: "2026-10-06T07:00:00Z", locations: [place("Berlin"), place("München", false)], workplace: "hybrid", salary: { ...eur(0, 0), min: null, max: null, perYear: null, eurPerYear: null, raw: "attractive" }, sources: ["greenhouse"], score: { result: "passed", rank: 91 }, signal: "T2" },
    { key: "J9", seen: "2026-10-05T07:00:00Z", locations: [], workplace: "remote", salary: eur(50_000, 60_000, "review"), sources: ["stepstone"], score: { result: "passed", rank: 60 } },
    { key: "J5", seen: "2026-10-03T07:00:00Z", locations: [place("Hamburg")], workplace: "onsite", salary: eur(200_000, 240_000), sources: ["linkedin-guest"], score: null },
    { key: "J6", seen: "2026-10-02T07:00:00Z", locations: [place("Rome")], workplace: "onsite", salary: null, sources: ["linkedin-guest"], score: { result: "filtered_out", rank: null, reasons: ["location_not_allowed:Rome"] } },
    { key: "J7", seen: "2026-09-30T20:00:00Z", locations: [place("Berlin")], workplace: "onsite", salary: null, sources: ["linkedin-guest"], score: { result: "passed", rank: 70 } },
    { key: "J8", seen: "2026-09-25T07:00:00Z", locations: [place("Berlin")], workplace: "onsite", salary: null, sources: ["greenhouse"], score: { result: "passed", rank: 70 } },
  ];

  const ids = new Map<string, number>();
  for (const def of defs) {
    const [job] = await db
      .insert(schema.jobs)
      .values({
        companyId,
        title: `Job ${def.key}`,
        titleNorm: `job ${def.key.toLowerCase()}`,
        locationsJson: def.locations,
        workplace: def.workplace,
        salaryJson: def.salary,
        firstSeenAt: new Date(def.seen),
        lastSeenAt: new Date(def.seen),
      })
      .returning();
    const jobId = job!.id;
    ids.set(def.key, jobId);
    for (const channelId of def.sources) {
      const [raw] = await db.insert(schema.rawPostings).values({ channelId, externalId: `${def.key}-${channelId}`, payloadJson: {} }).returning();
      await db.insert(schema.jobSources).values({ jobId, rawPostingId: raw!.id, channelId });
    }
    if (def.score) {
      await withRebuiltCurrentScores(db, db.insert(schema.scores).values({
        jobId,
        filterResult: def.score.result,
        filterReasons: def.score.reasons ?? [],
        score: def.score.rank === null ? null : Math.round(def.score.rank),
        rankValue: def.score.rank,
      }));
    }
    if (def.signal) {
      await db.insert(schema.signals).values({ jobId, tier: def.signal, kind: "test", quote: "quote", extractor: "rule", valueJson: def.signal === "T1" ? { eurPerYear: { min: 60_000, max: 80_000 } } : null });
    }
  }

  // applications: events inside the window (Berlin days), and one before it
  const at = (iso: string) => new Date(iso);
  const apps: Array<{ job: string; status: schema_ApplicationStatus; events: Array<[schema_ApplicationStatus | null, schema_ApplicationStatus, string]> }> = [
    { job: "J1", status: "rejected", events: [[null, "interested", "2026-10-06T09:00:00Z"], ["interested", "applied", "2026-10-07T08:00:00Z"], ["applied", "rejected", "2026-10-07T09:00:00Z"]] },
    { job: "J2", status: "interested", events: [[null, "interested", "2026-10-07T08:30:00Z"]] },
    { job: "J4", status: "offer", events: [[null, "interested", "2026-10-06T08:00:00Z"], ["interested", "preparing", "2026-10-06T09:00:00Z"], ["preparing", "applied", "2026-10-06T10:00:00Z"], ["applied", "interviewing", "2026-10-06T11:00:00Z"], ["interviewing", "offer", "2026-10-06T12:00:00Z"]] },
    { job: "J7", status: "interested", events: [[null, "interested", "2026-09-30T10:00:00Z"]] },
  ];
  for (const app of apps) {
    const last = app.events[app.events.length - 1]!;
    const [row] = await db.insert(schema.applications).values({ jobId: ids.get(app.job)!, status: app.status, statusChangedAt: at(last[2]) }).returning();
    for (const [from, to, when] of app.events) {
      await db.insert(schema.applicationEvents).values({ applicationId: row!.id, fromStatus: from, toStatus: to, at: at(when) });
    }
  }
}

type schema_ApplicationStatus = (typeof schema.applicationStatusEnum.enumValues)[number];

describe("insights aggregates", () => {
  it("counts jobs per day in the schedule time zone, passed and filtered apart", async () => {
    const daily = await getDailyCounts(getDb(), window);
    expect(daily).toEqual([
      { day: "2026-10-02", passed: 0, filtered: 1, avgRank: null },
      // J5 is not scored yet: no mean
      { day: "2026-10-03", passed: 1, filtered: 0, avgRank: null },
      { day: "2026-10-05", passed: 1, filtered: 0, avgRank: 60 },
      { day: "2026-10-06", passed: 1, filtered: 1, avgRank: 91 },
      // J1 was first seen 00:30 Berlin time on the 7th (22:30 UTC on the 6th)
      { day: "2026-10-07", passed: 2, filtered: 0, avgRank: 68.5 },
    ]);
    const utc = await getDailyCounts(getDb(), { ...window, timezone: "UTC" });
    expect(utc.find((d) => d.day === "2026-10-06")).toEqual({ day: "2026-10-06", passed: 2, filtered: 1, avgRank: 86.5 });
    expect(utc.find((d) => d.day === "2026-10-07")).toEqual({ day: "2026-10-07", passed: 1, filtered: 0, avgRank: 55 });
  });

  it("returns the whole picture", async () => {
    const data = await getInsightsData(getDb(), options);

    expect(data.previousTotal).toBe(2);
    // J7 and J8 both passed
    expect(data.previousPassed).toBe(2);
    // a job counts once per family it was seen in
    expect(data.sources).toEqual([
      { family: "linkedin", total: 4, passed: 3 },
      { family: "ats", total: 2, passed: 2 },
      { family: "stepstone", total: 2, passed: 1 },
    ]);
    expect(data.cities).toEqual({
      total: 5,
      remote: 1,
      other: 1,
      cities: [
        { city: "Berlin", count: 2 },
        { city: "München", count: 2 },
      ],
    });

    expect(data.salary.total).toBe(5);
    expect(data.salary.disclosed).toBe(4);
    // J4 states no figures and J9 is flagged for review: neither is comparable
    expect(data.salary.comparable).toBe(2);
    expect(data.salary.medianEurPerYear).toBe(145_000);
    expect(data.salaryCapIndex).toBe(15);
    expect(data.salary.buckets).toEqual([
      { index: 7, count: 1 },
      { index: 15, count: 1 },
    ]);

    expect(data.signals.total).toBe(5);
    expect(data.signals.tiers).toEqual([
      { tier: "T1", jobs: 1, avgRank: 82 },
      { tier: "T2", jobs: 1, avgRank: 91 },
      { tier: "T3", jobs: 1, avgRank: 55 },
      { tier: "T4", jobs: 0, avgRank: null },
    ]);
    expect(data.signals.withoutSignal).toBe(2);
    expect(data.signals.highPay).toBe(2);
    expect(data.signals.scored).toBe(4);
    expect(data.signals.avgRank).toBe(72);

    expect(data.scoreCapIndex).toBe(20);
    expect(data.scores).toEqual({
      // J1 (82) and J4 (91) are at or above the push line of 70
      atPushLine: 2,
      scored: 4,
      pending: 1,
      avgRank: 72,
      buckets: [
        { index: 11, count: 1 },
        { index: 12, count: 1 },
        { index: 16, count: 1 },
        { index: 18, count: 1 },
      ],
    });

    expect(data.funnel).toEqual({
      newJobs: 5,
      reached: { interested: 3, preparing: 2, applied: 2, interviewing: 1, offer: 1 },
      exits: { rejected: 1, withdrawn: 0, archived: 0 },
    });

    expect(data.filters).toEqual({
      total: 2,
      reasons: [
        { code: "location_not_allowed", jobs: 2 },
        { code: "contract_excluded", jobs: 1 },
      ],
    });
  });

  it("applies the T1 minimum to the high-pay count and cuts the reason list at the limit", async () => {
    const strict = await getInsightsData(getDb(), { ...options, highValue: { ...options.highValue, minAnnualEur: 90_000 }, topFilterReasons: 1 });
    // J1's amount (80k top) is below the minimum; J4's T2 equity still counts
    expect(strict.signals.highPay).toBe(1);
    expect(strict.filters.reasons).toHaveLength(1);
    expect((await getFilterStats(getDb(), window, 5)).reasons).toHaveLength(2);
  });

  it("lists the categories it is given, and counts high value by the categories marked so", async () => {
    // only T3 listed and only T3 high value: J?'s competitive pay counts, the amount and equity do not
    const custom = await getInsightsData(getDb(), { ...options, signalCategoryIds: ["T3"], highValue: { amountId: "T1", amountHighValue: false, otherIds: ["T3"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 } });
    expect(custom.signals.tiers).toEqual([{ tier: "T3", jobs: 1, avgRank: 55 }]);
    expect(custom.signals.highPay).toBe(1);
    expect(custom.signals.withoutSignal).toBe(4);
    const none = await getInsightsData(getDb(), { ...options, signalCategoryIds: [], highValue: { amountId: null, amountHighValue: false, otherIds: [], minAnnualEur: null, rates: {}, otherRegionPoints: 0 } });
    expect(none.signals).toMatchObject({ tiers: [], highPay: 0, withoutSignal: 5 });
  });

  it("a window without jobs gives zeros, not errors", async () => {
    const empty = { from: "2026-01-01", to: "2026-01-07", timezone: TZ };
    const data = await getInsightsData(getDb(), { ...options, window: empty, previous: { ...empty, from: "2025-12-25", to: "2025-12-31" } });
    expect(data.daily).toEqual([]);
    expect(data.sources).toEqual([]);
    expect(data.cities.total).toBe(0);
    expect(data.salary).toMatchObject({ total: 0, disclosed: 0, comparable: 0, medianEurPerYear: null, buckets: [] });
    expect(data.signals).toMatchObject({ total: 0, withoutSignal: 0, highPay: 0, avgRank: null });
    expect(data.scores).toMatchObject({ atPushLine: 0, scored: 0, pending: 0, avgRank: null });
    expect(data.funnel.reached).toEqual({ interested: 0, preparing: 0, applied: 0, interviewing: 0, offer: 0 });
    expect(data.filters).toEqual({ total: 0, reasons: [] });
  });
});

describe("insights view", () => {
  it("links every number to the /jobs filter that shows it", async () => {
    const config = insightsSchema.parse(shippedYaml("insights.yaml"));
    const data = await getInsightsData(getDb(), options);
    const view = buildInsightsView({ data, config, rangeDays: 7, window: { from: window.from, to: window.to }, pushLine: 70, salaryFloorEur: 70_000 });

    expect(view.kpi).toMatchObject({ total: 7, passed: 5, change: 2.5, applied: 2, hrefAll: "/jobs?from=2026-10-01&to=2026-10-07&filtered=true&status=active&status=possibly_closed&status=closed", hrefPassed: "/jobs?from=2026-10-01&to=2026-10-07&status=active&status=possibly_closed&status=closed" });
    expect(view.kpi.salaryRate).toBeCloseTo(0.8);
    // pass rate 5/7 against 2/2 in the previous window: the change is in percentage points
    expect(view.kpi.passRate).toBeCloseTo(5 / 7);
    expect(view.kpi.previousPassRate).toBe(1);
    expect(view.kpi.passRateChangePt).toBeCloseTo((5 / 7 - 1) * 100);
    expect(view.salary.floorEur).toBe(70_000);
    expect(view.daily.columns).toHaveLength(7);
    expect(view.daily.columns.find((c) => c.day === "2026-10-06")).toMatchObject({ passed: 1, filtered: 1, passedHref: "/jobs?from=2026-10-06&to=2026-10-06&status=active&status=possibly_closed&status=closed", filteredHref: "/jobs?from=2026-10-06&to=2026-10-06&filteredOnly=true&status=active&status=possibly_closed&status=closed" });
    // a filtered-out number opens a list of exactly that many jobs (the filtered ones only)
    const all = ["active", "possibly_closed", "closed"] as const;
    expect(await countJobList(getDb(), { filters: { from: "2026-10-06", to: "2026-10-06", filteredOnly: true, statuses: all }, timezone: TZ })).toBe(1);
    expect(await countJobList(getDb(), { filters: { from: window.from, to: window.to, filteredOnly: true, statuses: all }, timezone: TZ })).toBe(view.filters.total);
    expect(view.sources.rows[0]).toMatchObject({ family: "linkedin", href: "/jobs?from=2026-10-01&to=2026-10-07&source=linkedin&filtered=true&status=active&status=possibly_closed&status=closed", passedHref: "/jobs?from=2026-10-01&to=2026-10-07&source=linkedin&status=active&status=possibly_closed&status=closed" });
    expect(view.cities.rows.map((r) => [r.kind, r.city, r.count, r.href])).toEqual([
      ["city", "Berlin", 2, "/jobs?from=2026-10-01&to=2026-10-07&city=Berlin&status=active&status=possibly_closed&status=closed"],
      ["city", "München", 2, "/jobs?from=2026-10-01&to=2026-10-07&city=M%C3%BCnchen&status=active&status=possibly_closed&status=closed"],
      ["remote", null, 1, "/jobs?from=2026-10-01&to=2026-10-07&workplace=remote&status=active&status=possibly_closed&status=closed"],
      ["other", null, 1, null],
    ]);
    expect(view.signals.highPayHref).toBe("/jobs?from=2026-10-01&to=2026-10-07&high=true&status=active&status=possibly_closed&status=closed");
    // Conversion funnel: fetched -> passed the filter -> rank >= push line -> applied; every step from the same aggregates as the cards
    expect(view.conversion).toEqual({ fetched: 7, passed: 5, pushable: 2, applied: 2, pushLine: 70 });
    expect(view.conversion.fetched).toBe(view.kpi.total);
    expect(view.conversion.passed).toBe(view.kpi.passed);
    expect(view.conversion.applied).toBe(view.kpi.applied);
    expect(view.conversion.passed).toBe(view.cities.passed);
    expect(view.conversion.passed).toBe(view.salary.passed);
    expect(view.funnel.rows.map((r) => [r.key, r.count])).toEqual([["new", 5], ["interested", 3], ["preparing", 2], ["applied", 2], ["interviewing", 1], ["offer", 1]]);
  });

  it("loads from the database clock and the shipped config", async () => {
    temp = makeTempConfig();
    try {
      const view = await loadInsightsView(7, new Date("2026-10-07T12:00:00Z"));
      expect(view.window).toEqual({ from: "2026-10-01", to: "2026-10-07" });
      expect(view.kpi.total).toBe(7);
      // an unknown range falls back to the configured default (30 days)
      expect((await loadInsightsView(5, new Date("2026-10-07T12:00:00Z"))).rangeDays).toBe(30);
      expect((await loadInsightsView(null, new Date("2026-10-07T12:00:00Z"))).rangeDays).toBe(30);
    } finally {
      temp.cleanup();
    }
  });
});
