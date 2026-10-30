import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { buildKpiBlocks } from "@/lib/dashboard/kpi";
import { rowSalaryPercentile } from "@/lib/dashboard/salary";
import { annualBaseFigure } from "@/lib/domain/salary";
import { closeDb, countTodayJobs, countTodayQuickViews, getDb, getJobDetail, getLatestCycleSummary, listCycleNewJobs, listJobs, listMonthSalaryFigures, listRecentCycleKpis, listTodayJobs, loadMonthSalaryStats, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { seedDatabase } from "@/lib/db/seed";
import type { JobSalary } from "@/lib/domain/types";
import { asSalary } from "../helpers/salary";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const SEED_NOW = new Date("2026-10-07T12:00:00Z");
const PUSH_LINE = 70;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, notifications, runtime_state restart identity cascade`);
  await seedDatabase(getDb(), { now: SEED_NOW, timezone: TZ });
});

afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, notifications restart identity cascade`);
  await closeDb();
});

const salary = (min: number | null, max: number | null, over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min,
  max,
  perYear: { min, max },
  eurPerYear: { min, max },
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

interface Fixture {
  title: string;
  at: string;
  result?: "passed" | "filtered_out";
  rank?: number | null;
  salary?: JobSalary | null;
}

async function insertJobs(companyId: number, fixtures: readonly Fixture[]): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db
    .insert(schema.jobs)
    .values(fixtures.map((f) => ({ companyId, title: f.title, titleNorm: f.title, firstSeenAt: new Date(f.at), salaryJson: f.salary ?? null })))
    .returning({ id: schema.jobs.id, title: schema.jobs.title });
  const ids = new Map(rows.map((row) => [row.title, row.id]));
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values(
    fixtures.map((f) => ({ jobId: ids.get(f.title)!, filterResult: f.result ?? "passed", rankValue: f.rank ?? null, score: f.rank ?? null, filterReasons: [] })),
  ));
  return ids;
}

describe("listRecentCycleKpis: the numbers behind the summary blocks of Today", () => {
  async function build() {
    const db = getDb();
    // the seed's own cycles would be part of the series: start from none
    await db.delete(schema.cycles);
    const [company] = await db.select().from(schema.companies).limit(1);
    const [c1, c2, skipped] = await db
      .insert(schema.cycles)
      .values([
        { kind: "weekday_morning", status: "succeeded", startedAt: new Date("2031-03-01T10:00:00Z"), finishedAt: new Date("2031-03-01T10:06:00Z") },
        { kind: "weekday_evening", status: "succeeded", startedAt: new Date("2031-03-02T10:00:00Z"), finishedAt: new Date("2031-03-02T10:06:00Z") },
        { kind: "manual", status: "skipped", startedAt: new Date("2031-03-03T10:00:00Z"), finishedAt: new Date("2031-03-03T10:00:01Z") },
      ])
      .returning();
    await db.insert(schema.runs).values([
      { cycleId: c1!.id, channelId: "lever", status: "succeeded", fetched: 100, newCount: 3 },
      { cycleId: c1!.id, channelId: "greenhouse", status: "succeeded", fetched: 20, newCount: 0 },
      { cycleId: c2!.id, channelId: "lever", status: "succeeded", fetched: 200, newCount: 4 },
      { cycleId: skipped!.id, channelId: "lever", status: "skipped", fetched: 999, newCount: 0 },
    ]);
    await insertJobs(company!.id, [
      { title: "k1", at: "2031-03-01T10:02:00Z", rank: 80, salary: salary(80_000, 100_000) },
      { title: "k2", at: "2031-03-01T10:03:00Z", rank: 50 },
      { title: "k3", at: "2031-03-01T10:04:00Z", result: "filtered_out", salary: salary(60_000, 70_000) },
      { title: "m1", at: "2031-03-02T10:01:00Z", rank: 90, salary: salary(90_000, 110_000) },
      { title: "m2", at: "2031-03-02T10:02:00Z", rank: 75, salary: salary(90_000, 110_000, { qualityStatus: "review" }) },
      { title: "m3", at: "2031-03-02T10:03:00Z", rank: 65, salary: salary(129_000, 156_000, { currency: "USD", otherRegion: "currency" }) },
      { title: "outside", at: "2031-03-02T12:00:00Z", rank: 99 },
    ]);
    const job = (cycleId: number, sentAt: Date | null) => ({ kind: "job", cycleId, payloadJson: {}, sentAt });
    await db.insert(schema.notifications).values([
      job(c1!.id, new Date("2031-03-01T10:05:00Z")),
      job(c2!.id, new Date("2031-03-02T10:05:00Z")),
      job(c2!.id, new Date("2031-03-02T10:05:30Z")),
      job(c2!.id, null), // cut by the cap: never sent
      { kind: "cycle_summary", cycleId: c2!.id, payloadJson: {}, sentAt: new Date("2031-03-02T10:05:00Z") },
    ]);
    return { c1: c1!, c2: c2! };
  }

  it("counts fetched, passed, at-or-above the push line, salary stated and pushed per cycle, oldest first", async () => {
    const { c1, c2 } = await build();
    const series = await listRecentCycleKpis(getDb(), { limit: 7, qualifiedMinRank: PUSH_LINE });
    expect(series.map((point) => point.cycleId)).toEqual([c1.id, c2.id]);
    expect(series[0]).toMatchObject({ fetched: 120, passed: 2, qualified: 1, salaryStated: 1, pushed: 1 });
    // c2: m1 90, m2 75 (salary under review: not counted), m3 65 (another region's pay: counted, it is drawn)
    expect(series[1]).toMatchObject({ fetched: 200, passed: 3, qualified: 2, salaryStated: 2, pushed: 2 });
  });

  it("agrees with the cycle summary of the strip for the latest cycle", async () => {
    const { c2 } = await build();
    const db = getDb();
    const summary = await getLatestCycleSummary(db, { qualifiedMinRank: PUSH_LINE });
    const last = (await listRecentCycleKpis(db, { limit: 7, qualifiedMinRank: PUSH_LINE })).at(-1);
    expect(summary?.id).toBe(c2.id);
    expect(last).toMatchObject({ cycleId: summary?.id, fetched: summary?.fetched, passed: summary?.passedCount, qualified: summary?.qualifiedCount });
  });

  it("keeps historical KPI counts working before the dormancy columns exist", async () => {
    const { c1, c2 } = await build();
    const rollback = new Error("deliberate rollback");
    await expect(getDb().transaction(async (tx) => {
      await tx.execute(sql`alter table jobs drop column dormant_at, drop column possibly_closed_at`);
      const series = await listRecentCycleKpis(tx, { limit: 7, qualifiedMinRank: PUSH_LINE });
      expect(series.map((point) => point.cycleId)).toEqual([c1.id, c2.id]);
      expect(series[0]).toMatchObject({ fetched: 120, passed: 2, qualified: 1, salaryStated: 1, pushed: 1 });
      expect(series[1]).toMatchObject({ fetched: 200, passed: 3, qualified: 2, salaryStated: 2, pushed: 2 });
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("feeds the blocks: value, share of fetched, change against the previous cycle, series", async () => {
    await build();
    const blocks = buildKpiBlocks(await listRecentCycleKpis(getDb(), { limit: 7, qualifiedMinRank: PUSH_LINE }), 7);
    const byKey = Object.fromEntries(blocks.map((block) => [block.key, block]));
    expect(byKey.fetched).toMatchObject({ value: 200, delta: 80, series: [120, 200] });
    expect(byKey.passed).toMatchObject({ value: 3, share: 1.5, delta: 1, series: [2, 3] });
    expect(byKey.qualified).toMatchObject({ value: 2, share: 1, delta: 1 });
    expect(byKey.salary).toMatchObject({ value: 2, delta: 1 });
    expect(byKey.pushed).toMatchObject({ value: 2, share: 1, delta: 1, series: [1, 2] });
  });

  it("keeps only the last N cycles and gives unknown (not 0) for the push line without a threshold", async () => {
    const { c2 } = await build();
    const one = await listRecentCycleKpis(getDb(), { limit: 1, qualifiedMinRank: null });
    expect(one.map((point) => point.cycleId)).toEqual([c2.id]);
    expect(one[0]?.qualified).toBeNull();
  });

  it("is empty before the first cycle", async () => {
    await getDb().execute(sql`truncate table cycles restart identity cascade`);
    expect(await listRecentCycleKpis(getDb(), { limit: 7, qualifiedMinRank: PUSH_LINE })).toEqual([]);
  });
});

describe("listMonthSalaryFigures: the distribution behind the percentile", () => {
  it("holds this month's annual EUR figures (a range counts by its middle, a half-open one by its bound), without under-review, other-region ones and other months", async () => {
    const [company] = await getDb().select().from(schema.companies).limit(1);
    await insertJobs(company!.id, [
      { title: "a", at: "2031-03-04T10:00:00Z", rank: 70, salary: salary(80_000, 100_000) },
      { title: "b", at: "2031-03-05T10:00:00Z", rank: 70, salary: salary(100_000, 140_000) },
      { title: "open", at: "2031-03-06T10:00:00Z", rank: 70, salary: salary(70_000, null) },
      { title: "other-region", at: "2031-03-06T10:00:00Z", rank: 70, salary: salary(129_000, 156_000, { otherRegion: "currency" }) },
      { title: "review", at: "2031-03-06T10:00:00Z", rank: 70, salary: salary(50_000, 60_000, { qualityStatus: "review" }) },
      { title: "february", at: "2031-02-27T10:00:00Z", rank: 70, salary: salary(200_000, 220_000) },
      { title: "april", at: "2031-03-31T22:00:00Z", rank: 70, salary: salary(200_000, 220_000) }, // 00:00 Berlin, April
      { title: "none", at: "2031-03-06T10:00:00Z", rank: 70 },
    ]);
    const figures = await listMonthSalaryFigures(getDb(), { now: new Date("2031-03-15T12:00:00Z"), timeZone: TZ, currency: "EUR" });
    expect(figures.map((entry) => entry.figure).sort((x, y) => x - y)).toEqual([70_000, 90_000, 120_000]);
  });

  it("uses the month of the time zone", async () => {
    const [company] = await getDb().select().from(schema.companies).limit(1);
    // 2031-02-28 23:30 UTC is already 2031-03-01 00:30 in Berlin
    await insertJobs(company!.id, [{ title: "edge", at: "2031-02-28T23:30:00Z", rank: 70, salary: salary(80_000, 100_000) }]);
    const now = new Date("2031-03-15T12:00:00Z");
    expect((await listMonthSalaryFigures(getDb(), { now, timeZone: TZ, currency: "EUR" })).map((entry) => entry.figure)).toEqual([90_000]);
    expect(await listMonthSalaryFigures(getDb(), { now, timeZone: "UTC", currency: "EUR" })).toEqual([]);
  });

  it("list rows and the detail page give the same percentile and the same median for the same job", async () => {
    const db = getDb();
    const [company] = await db.select().from(schema.companies).limit(1);
    const ids = await insertJobs(company!.id, [
      { title: "p1", at: "2031-03-02T10:00:00Z", rank: 70, salary: salary(50_000, 70_000) },
      { title: "p2", at: "2031-03-03T10:00:00Z", rank: 70, salary: salary(80_000, 80_000) },
      { title: "p3", at: "2031-03-04T10:00:00Z", rank: 70, salary: salary(90_000, 110_000) },
      { title: "p4", at: "2031-03-05T10:00:00Z", rank: 70, salary: salary(null, 120_000) },
      { title: "p5", at: "2031-03-06T10:00:00Z", rank: 70, salary: salary(140_000, null) },
      { title: "p6", at: "2031-03-07T10:00:00Z", rank: 70, salary: salary(100_000, 100_000) },
      { title: "other", at: "2031-03-07T10:00:00Z", rank: 70, salary: salary(129_000, 156_000, { otherRegion: "currency" }) },
      { title: "none", at: "2031-03-07T10:00:00Z", rank: 70 },
    ]);
    const now = new Date("2031-03-15T12:00:00Z");
    const month = { figures: await listMonthSalaryFigures(db, { now, timeZone: TZ, currency: "EUR" }), minSample: 5, currency: "EUR" };
    const page = await listJobs(db, { filters: { includeFiltered: true, from: "2031-03-01", to: "2031-03-31" }, sort: "first_seen", page: 1, pageSize: 50, timezone: TZ });
    expect(page.jobs.map((job) => job.title).sort()).toEqual(["none", "other", "p1", "p2", "p3", "p4", "p5", "p6"]);
    for (const card of page.jobs) {
      const detail = await getJobDetail(db, card.id);
      const stats = await loadMonthSalaryStats(db, { now, timeZone: TZ, jobId: card.id, figure: annualBaseFigure(detail!.salary, "EUR"), minSample: 5, currency: "EUR" });
      expect(rowSalaryPercentile(card, month), card.title).toBe(stats.percentile);
    }
    // a plain job gets a real number, the other region's pay and the undisclosed one get none, on both pages
    const byTitle = (title: string) => page.jobs.find((job) => job.title === title)!;
    expect(rowSalaryPercentile(byTitle("p3"), month)).toBe(40); // of the other five figures (60, 80, 120, 140, 100) two are below 100k; the tie is not below
    expect(rowSalaryPercentile(byTitle("other"), month)).toBeNull();
    expect(rowSalaryPercentile(byTitle("none"), month)).toBeNull();
    void ids;
    // below the minimum sample there is nothing on either page
    expect(rowSalaryPercentile(byTitle("p3"), { ...month, minSample: 7 })).toBeNull();
    expect((await loadMonthSalaryStats(db, { now, timeZone: TZ, jobId: byTitle("p3").id, figure: 100_000, minSample: 7, currency: "EUR" })).percentile).toBeNull();
  });
});

describe("listRecentCycleKpis: a failed step makes its blocks unknown", () => {
  it("returns the waiting count and the blocks that must not show a 0", async () => {
    const db = getDb();
    await db.delete(schema.cycles);
    const [c] = await db
      .insert(schema.cycles)
      .values({ kind: "weekday_morning", status: "partial", startedAt: new Date("2031-03-01T10:00:00Z"), finishedAt: new Date("2031-03-01T10:06:00Z"), summaryJson: { steps: [{ name: "pipeline", status: "failed" }, { name: "notify", status: "ok" }] } })
      .returning();
    const [run] = await db.insert(schema.runs).values({ cycleId: c!.id, channelId: "lever", status: "succeeded", fetched: 40, newCount: 4 }).returning();
    await db.insert(schema.rawPostings).values([1, 2, 3, 4].map((n) => ({ channelId: "lever", externalId: `w-${n}`, payloadJson: {}, parseStatus: "pending" as const, runId: run!.id })));
    const [point] = await listRecentCycleKpis(db, { limit: 7, qualifiedMinRank: PUSH_LINE });
    expect(point).toMatchObject({ fetched: 40, unprocessed: 4, unprocessedBlocks: { passed: "unprocessed", salary: "unprocessed", qualified: "unprocessed" } });
    const blocks = buildKpiBlocks([point!], 7);
    expect(blocks.find((block) => block.key === "passed")).toMatchObject({ value: null, pending: { reason: "unprocessed", count: 4 } });
    expect(blocks.find((block) => block.key === "pushed")).toMatchObject({ value: 0, pending: null });
  });
});

describe("the view switch of Today: counts from the same selection as the list", () => {
  const lines = { qualifiedMinRank: PUSH_LINE, qualifiedMinRankWithSignals: 60 };

  it("counts all, high score, salary stated and following up in one query, the same as the list shows", async () => {
    const db = getDb();
    const summary = await getLatestCycleSummary(db, { qualifiedMinRank: PUSH_LINE });
    const base = { now: SEED_NOW, timezone: TZ, cycle: summary };
    const counts = await countTodayQuickViews(db, { ...base, quickLines: lines });
    const all = await listTodayJobs(db, base);
    expect(counts.all).toBe(all.length);
    expect(counts.high).toBeGreaterThan(0);
    expect(counts.salary).toBeGreaterThan(0);
    expect(counts.following).toBeGreaterThan(0);
    for (const quick of ["high", "salary", "following"] as const) {
      const list = await listTodayJobs(db, { ...base, quick, quickLines: lines });
      expect(list.length, quick).toBe(counts[quick]);
      expect(list.length, quick).toBeLessThanOrEqual(counts.all);
    }
    const high = await listTodayJobs(db, { ...base, quick: "high", quickLines: lines });
    expect(high.every((job) => (job.rank?.rankValue ?? 0) >= 60)).toBe(true);
    expect(await countTodayJobs(db, { ...base, extra: { salaryDisclosed: true } })).toBeGreaterThan(0);
  });
});

describe("listCycleNewJobs: what the ticker scrolls", () => {
  it("lists the jobs first seen inside the cycle, best rank first, without filtered or ignored ones, and honours the limit", async () => {
    const db = getDb();
    const [company] = await db.select().from(schema.companies).limit(1);
    const ids = await insertJobs(company!.id, [
      { title: "low", at: "2031-03-02T10:01:00Z", rank: 60 },
      { title: "top", at: "2031-03-02T10:02:00Z", rank: 91, salary: salary(90_000, 110_000) },
      { title: "unscored", at: "2031-03-02T10:03:00Z", rank: null },
      { title: "filtered", at: "2031-03-02T10:03:00Z", result: "filtered_out" },
      { title: "ignored", at: "2031-03-02T10:04:00Z", rank: 80 },
      { title: "before", at: "2031-03-01T10:00:00Z", rank: 95 },
    ]);
    await db.insert(schema.applications).values({ jobId: ids.get("ignored")!, status: "archived" });
    const cycle = { startedAt: new Date("2031-03-02T10:00:00Z"), finishedAt: new Date("2031-03-02T10:06:00Z") };
    const jobs = await listCycleNewJobs(db, cycle, 8);
    expect(jobs.map((job) => job.title)).toEqual(["top", "low", "unscored"]);
    expect(jobs[0]).toMatchObject({ rankValue: 91, salary: { eurPerYear: { min: 90_000, max: 110_000 } } });
    expect(jobs[2]?.rankValue).toBeNull();
    expect(await listCycleNewJobs(db, cycle, 2)).toHaveLength(2);
  });
});
