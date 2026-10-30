import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, getSalaryStats, loadMonthSalaryStats } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
// 14:00 Berlin on 2026-10-07: the month runs from 2026-09-30 22:00Z to 2026-10-31 23:00Z
const NOW = new Date("2026-10-07T12:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
});
afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
  await closeDb();
});

const eur = (min: number | null, max: number | null, extra: Record<string, unknown> = {}) => ({
  raw: "x",
  currency: "EUR",
  period: "year",
  min,
  max,
  perYear: { min, max },
  eurPerYear: { min, max },
  periodAssumed: false,
  origin: "description",
  qualityStatus: "valid",
  reasonCodes: [],
  ...extra,
});

async function add(title: string, salaryJson: unknown, firstSeenAt: Date = NOW): Promise<number> {
  const db = getDb();
  const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
  const job = await insertJob(db, { companyId: company.id, title, titleNorm: title.toLowerCase(), salaryJson, firstSeenAt });
  return job.id;
}

describe("loadMonthSalaryStats", () => {
  it("gives the median and where a job stands among this month's stated salaries", async () => {
    // figures: 60k, 80k, 100k, 120k, 140k (a range counts by its middle)
    await add("a", eur(50000, 70000));
    await add("b", eur(80000, 80000));
    const self = await add("c", eur(90000, 110000));
    await add("d", eur(null, 120000));
    await add("e", eur(140000, null));
    const stats = await loadMonthSalaryStats(getDb(), { now: NOW, timeZone: TZ, jobId: self, figure: 100000, minSample: 5, currency: "EUR" });
    expect(stats.count).toBe(5);
    expect(stats.median).toBe(100000);
    // of the other four (60, 80, 120, 140) two are below 100k
    expect(stats.percentile).toBe(50);
  });

  it("leaves out other months, no salary, salaries under review and other regions' pay", async () => {
    await add("a", eur(80000, 80000));
    await add("old", eur(10000, 10000), new Date("2026-09-30T21:59:00Z")); // 23:59 Berlin, September
    await add("next", eur(10000, 10000), new Date("2026-10-31T23:00:00Z")); // 00:00 Berlin, November
    await add("none", null);
    await add("review", eur(10000, 10000, { qualityStatus: "review" }));
    await add("other", eur(10000, 10000, { otherRegion: "currency" }));
    await add("no eur", { ...eur(null, null), eurPerYear: null });
    const stats = await loadMonthSalaryStats(getDb(), { now: NOW, timeZone: TZ, jobId: 0, figure: null, minSample: 1, currency: "EUR" });
    expect(stats.count).toBe(1);
    expect(stats.median).toBe(80000);
    expect(stats.percentile).toBeNull(); // the job has no figure of its own
  });

  it("says nothing below the minimum sample", async () => {
    const self = await add("a", eur(80000, 80000));
    await add("b", eur(90000, 90000));
    const stats = await loadMonthSalaryStats(getDb(), { now: NOW, timeZone: TZ, jobId: self, figure: 80000, minSample: 5, currency: "EUR" });
    expect(stats).toEqual({ count: 2, median: null, percentile: null });
  });

  it("is empty on an empty month", async () => {
    expect(await loadMonthSalaryStats(getDb(), { now: NOW, timeZone: TZ, jobId: 1, figure: 80000, minSample: 1, currency: "EUR" })).toEqual({ count: 0, median: null, percentile: null });
  });
});

describe("one median for the detail page, /insights and /me", () => {
  const window = { from: "2026-10-01", to: "2026-10-31", timezone: TZ };

  it("gives /insights the detail page's median over the same jobs: midpoints and single bounds, no other region, no review", async () => {
    await add("a", eur(50000, 70000)); // 60k
    await add("b", eur(80000, 80000)); // 80k
    await add("c", eur(90000, 110000)); // 100k
    await add("d", eur(null, 120000)); // 120k, a single bound counts
    await add("e", eur(140000, null)); // 140k
    await add("other", eur(150000, 190000, { otherRegion: "currency" })); // left out
    await add("review", eur(150000, 190000, { qualityStatus: "review" })); // left out
    await add("none", null);
    const detail = await loadMonthSalaryStats(getDb(), { now: NOW, timeZone: TZ, jobId: 0, figure: null, minSample: 5, currency: "EUR" });
    const insights = await getSalaryStats(getDb(), window, 10_000, 15, 5, "EUR");
    expect(insights.comparable).toBe(detail.count);
    expect(insights.medianEurPerYear).toBe(detail.median);
    expect(insights.medianEurPerYear).toBe(100000);
    // 60k, 80k, 100k, 120k, 140k: one job in each of the buckets 6, 8, 10, 12, 14
    expect(insights.buckets).toEqual([6, 8, 10, 12, 14].map((index) => ({ index, count: 1 })));
    expect(insights.disclosed).toBe(8 - 1); // every job with a salary object, the one without is not
  });

  it("has no median below the minimum sample, but still draws the bars", async () => {
    await add("a", eur(80000, 80000));
    await add("b", eur(90000, 90000));
    const insights = await getSalaryStats(getDb(), window, 10_000, 15, 5, "EUR");
    expect(insights.medianEurPerYear).toBeNull();
    expect(insights.minSample).toBe(5);
    expect(insights.buckets).toEqual([
      { index: 8, count: 1 },
      { index: 9, count: 1 },
    ]);
  });
});
