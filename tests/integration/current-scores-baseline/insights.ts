// Frozen pre-projection query baseline.
import { and, asc, count, desc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";

import { summarizeMonthSalaries } from "@/lib/domain/salary";

import type { Db } from "@/lib/db/client";
import { jobHasCityIn } from "./jobs";
import { annualBaseFigureSql, comparableSalaryWhere } from "@/lib/db/queries/salary-figure";
import { latestScoreCte, type LatestScore } from "./job-cards";
import { hasHighValueSignal, policyCurrency, type HighValuePolicy } from "@/lib/db/queries/signal-filter";
import { channels, jobSources, jobs, signals } from "@/lib/db/schema";

/**
 * Aggregates behind /insights. Every number is a SQL aggregate over the jobs first seen inside a
 * window of whole days (`YYYY-MM-DD`, inclusive, in `timezone`: the same reading as the `from` / `to`
 * filters of /jobs, so a count here is the count /jobs shows after the click). Nothing here loads rows
 * into memory beyond the grouped result.
 *
 * "Passed" = the job's newest score row does not say `filtered_out` (a job without a score row is not
 * hidden by /jobs either). The score comes from `latestScoreCte`, the same one the job lists use.
 */

export interface InsightsWindow {
  /** First day, `YYYY-MM-DD` in `timezone`. */
  from: string;
  /** Last day, inclusive. */
  to: string;
  timezone: string;
}

export interface InsightsOptions {
  window: InsightsWindow;
  /** The window of the same length right before `window` (for the change figure of the headline tile). */
  previous: InsightsWindow;
  /** Cities that get their own row (`locations_json[].city`). */
  cities: readonly string[];
  /** The raw `locations_json[].city` values behind each listed city (its metro area and spellings); a city missing here counts as itself. Must match what /jobs shows for the city. */
  cityMembers?: Readonly<Record<string, readonly string[]>>;
  topFilterReasons: number;
  /** Rank value from which a job counts as "pushable" (`notify.yaml: push_min_score`): the third step of the conversion funnel. */
  pushMinScore: number;
  scoreBucketWidth: number;
  scoreBucketCap: number;
  salaryBucketEur: number;
  salaryBucketCapEur: number;
  /** `ui.yaml: salary_stats.min_sample`: below this many comparable salaries the window has no median (the same minimum as the detail page). */
  salaryMinSample: number;
  /** What makes a job high value (the "high-value signals only" quick filter of /jobs). */
  highValue: HighValuePolicy;
  /** The categories the signal card lists (active, not tag kind), in order. */
  signalCategoryIds: readonly string[];
}

export interface DailyCount {
  day: string;
  passed: number;
  filtered: number;
  /** Mean rank value of that day's passed jobs; null when none of them is scored yet. */
  avgRank: number | null;
}

export interface SourceCount {
  family: string;
  total: number;
  passed: number;
}

export interface CityCounts {
  /** Passed jobs in the window. */
  total: number;
  remote: number;
  /** Not remote and in none of the listed cities. */
  other: number;
  /** One entry per listed city, in the order given: jobs with a location in that city (a job can be in several cities). */
  cities: { city: string; count: number }[];
}

export interface Bucket {
  /** `lower bound = index * width`; the last index (`capIndex`) is open-ended. */
  index: number;
  count: number;
}

export interface SalaryStats {
  /** Passed jobs in the window. */
  total: number;
  /** `salary_json` is present. */
  disclosed: number;
  /** Passed jobs with a comparable salary figure (`annualEurFigure`: range midpoint or the one stated bound; not under review, not another region's pay). */
  comparable: number;
  /** Median of those figures, by `summarizeMonthSalaries` like the detail page and /me; null below `salaryMinSample`. */
  medianEurPerYear: number | null;
  /** The minimum the median needs (`ui.yaml: salary_stats.min_sample`), for the "not enough" note. */
  minSample: number;
  buckets: Bucket[];
}

export interface TierStat {
  /** Category id. */
  tier: string;
  /** Passed jobs with at least one signal of the category. */
  jobs: number;
  avgRank: number | null;
}

export interface SignalStats {
  /** Passed jobs in the window. */
  total: number;
  tiers: TierStat[];
  /** Passed jobs without any signal of the listed categories. */
  withoutSignal: number;
  /** Passed jobs with a signal the "high-value signals only" quick filter accepts (the count /jobs shows with `high=true`). */
  highPay: number;
  /** Passed jobs that have a rank value. */
  scored: number;
  avgRank: number | null;
}

export interface ScoreStats {
  /** Passed jobs with a rank value at or above `pushMinScore`. */
  atPushLine: number;
  scored: number;
  /** Passed jobs without a rank value yet (waiting for the AI). */
  pending: number;
  avgRank: number | null;
  buckets: Bucket[];
}

/** Application statuses the funnel climbs, in order. */
export const FUNNEL_STAGES = ["interested", "preparing", "applied", "interviewing", "offer"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/** Statuses that leave the funnel. */
export const FUNNEL_EXITS = ["rejected", "withdrawn", "archived"] as const;
export type FunnelExit = (typeof FUNNEL_EXITS)[number];

export interface FunnelStats {
  /** Passed jobs first seen in the window. */
  newJobs: number;
  /** Applications that reached each stage (or any later one) through a status change inside the window. */
  reached: Record<FunnelStage, number>;
  /** Applications that moved to each exit status inside the window. */
  exits: Record<FunnelExit, number>;
}

export interface ReasonCount {
  /** Reason code without its detail (`salary_below_floor`, not `salary_below_floor:60000`). */
  code: string;
  jobs: number;
}

export interface FilterStats {
  /** Filtered-out jobs in the window. */
  total: number;
  reasons: ReasonCount[];
}

export interface InsightsData {
  daily: DailyCount[];
  /** Jobs first seen in the previous window. */
  previousTotal: number;
  /** Of those, the ones that passed the filter (for the percentage-point change of the pass rate). */
  previousPassed: number;
  sources: SourceCount[];
  cities: CityCounts;
  salary: SalaryStats;
  signals: SignalStats;
  scores: ScoreStats;
  funnel: FunnelStats;
  filters: FilterStats;
  /** Index of the open-ended last bucket of the histograms. */
  scoreCapIndex: number;
  salaryCapIndex: number;
}

const startOf = (w: InsightsWindow): SQL => sql`((${w.from}::date)::timestamp at time zone ${w.timezone})`;
const endOf = (w: InsightsWindow): SQL => sql`((${w.to}::date + 1)::timestamp at time zone ${w.timezone})`;
const firstSeenIn = (w: InsightsWindow): SQL => sql`(${jobs.firstSeenAt} >= ${startOf(w)} and ${jobs.firstSeenAt} < ${endOf(w)})`;
const passedOf = (latest: LatestScore): SQL => sql`(${latest.filterResult} is distinct from 'filtered_out')`;
const filteredOf = (latest: LatestScore): SQL => sql`(${latest.filterResult} = 'filtered_out')`;

const num = (value: number | string | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

/** Index of the open-ended last bucket: `cap` rounded down to a bucket boundary (at least 1). */
export function capIndex(cap: number, width: number): number {
  return Math.max(1, Math.floor(cap / width));
}

/** Jobs first seen per day, passed and filtered out apart. Days without a job are absent. */
export async function getDailyCounts(db: Db, window: InsightsWindow): Promise<DailyCount[]> {
  const latest = latestScoreCte(db);
  const rows = await db
    .with(latest)
    .select({
      day: sql<string>`to_char((${jobs.firstSeenAt} at time zone ${window.timezone})::date, 'YYYY-MM-DD')`,
      passed: sql<number>`count(*) filter (where ${passedOf(latest)})::int`,
      filtered: sql<number>`count(*) filter (where ${filteredOf(latest)})::int`,
      avgRank: sql<number | null>`(avg(${latest.rankValue}) filter (where ${passedOf(latest)}))::float8`,
    })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(firstSeenIn(window))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((row) => ({ ...row, avgRank: numOrNull(row.avgRank) }));
}

/** Jobs first seen in the window (any filter result). */
export async function countJobsFirstSeen(db: Db, window: InsightsWindow): Promise<number> {
  const [row] = await db.select({ n: count() }).from(jobs).where(firstSeenIn(window));
  return row?.n ?? 0;
}

/** Jobs first seen in the window that passed the filter (same reading of "passed" as everywhere in this file). */
export async function countPassedFirstSeen(db: Db, window: InsightsWindow): Promise<number> {
  const latest = latestScoreCte(db);
  const [row] = await db
    .with(latest)
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(firstSeenIn(window), passedOf(latest)));
  return row?.n ?? 0;
}

/** Jobs per source family, with how many passed the filter. A job counts once per family it was seen in. */
export async function getSourceCounts(db: Db, window: InsightsWindow): Promise<SourceCount[]> {
  const latest = latestScoreCte(db);
  const distinctJobs = sql`count(distinct ${jobs.id})`;
  return db
    .with(latest)
    .select({
      family: channels.family,
      total: sql<number>`${distinctJobs}::int`,
      passed: sql<number>`${distinctJobs} filter (where ${passedOf(latest)})::int`,
    })
    .from(jobs)
    .innerJoin(jobSources, eq(jobSources.jobId, jobs.id))
    .innerJoin(channels, eq(channels.id, jobSources.channelId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(firstSeenIn(window))
    .groupBy(channels.family)
    .orderBy(desc(distinctJobs), asc(channels.family));
}

/** Passed jobs per city bucket: the listed cities, remote and the rest. */
export async function getCityCounts(db: Db, window: InsightsWindow, cities: readonly string[], cityMembers: Readonly<Record<string, readonly string[]>> = {}): Promise<CityCounts> {
  const latest = latestScoreCte(db);
  const inCity = (city: string): SQL => jobHasCityIn(cityMembers[city] ?? [city]);
  const inAnyCity = cities.length > 0 ? sql`(${sql.join(cities.map(inCity), sql` or `)})` : sql`false`;
  const where = and(firstSeenIn(window), passedOf(latest));

  const [summary, perCity] = await Promise.all([
    db
      .with(latest)
      .select({
        total: sql<number>`count(*)::int`,
        remote: sql<number>`count(*) filter (where ${jobs.workplace} = 'remote')::int`,
        other: sql<number>`count(*) filter (where ${jobs.workplace} <> 'remote' and not ${inAnyCity})::int`,
      })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(where),
    Promise.all(
      cities.map(async (city) => {
        const [row] = await db
          .with(latest)
          .select({ n: sql<number>`count(*)::int` })
          .from(jobs)
          .leftJoin(latest, eq(latest.jobId, jobs.id))
          .where(and(where, inCity(city)));
        return { city, count: row?.n ?? 0 };
      }),
    ),
  ]);
  return { total: summary[0]?.total ?? 0, remote: summary[0]?.remote ?? 0, other: summary[0]?.other ?? 0, cities: perCity };
}

/**
 * How many passed jobs state a salary, and how the comparable ones spread over annual buckets in the base currency `currency`.
 * A comparable salary is the one every median of the app is made of (`annualBaseFigure`, here `annualBaseFigureSql`); the median itself is
 * `summarizeMonthSalaries`, the function of the detail page and the /me floor preview, over this window's figures.
 */
export async function getSalaryStats(db: Db, window: InsightsWindow, width: number, capIdx: number, minSample: number, currency: string): Promise<SalaryStats> {
  const latest = latestScoreCte(db);
  const where = and(firstSeenIn(window), passedOf(latest));
  const [summary, figureRows] = await Promise.all([
    db
      .with(latest)
      .select({
        total: sql<number>`count(*)::int`,
        disclosed: sql<number>`count(*) filter (where ${jobs.salaryJson} is not null and ${jobs.salaryJson} <> 'null'::jsonb)::int`,
      })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(where),
    db
      .with(latest)
      .select({ id: jobs.id, figure: sql<number>`(${annualBaseFigureSql(currency)})::float8` })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(and(where, comparableSalaryWhere, sql`${annualBaseFigureSql(currency)} > 0`)),
  ]);
  const figures = figureRows.map((row) => ({ id: row.id, figure: Number(row.figure) }));
  const counts = new Map<number, number>();
  for (const { figure } of figures) {
    const index = Math.min(Math.floor(figure / width), capIdx);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const row = summary[0];
  return {
    total: row?.total ?? 0,
    disclosed: row?.disclosed ?? 0,
    comparable: figures.length,
    medianEurPerYear: summarizeMonthSalaries(figures, { jobId: 0, figure: null, minSample }).median,
    minSample,
    buckets: [...counts].map(([index, count]) => ({ index, count })).sort((x, y) => x.index - y.index),
  };
}

/** Passed jobs per signal category (`categoryIds`), their mean rank value, and how many carry no signal of them at all. */
export async function getSignalStats(db: Db, window: InsightsWindow, highValue: HighValuePolicy, categoryIds: readonly string[]): Promise<SignalStats> {
  const latest = latestScoreCte(db);
  const where = and(firstSeenIn(window), passedOf(latest));
  const ids = categoryIds.length > 0 ? [...categoryIds] : null;
  const hasTierSignal = ids
    ? exists(
        db
          .select({ one: sql`1` })
          .from(signals)
          .where(and(eq(signals.jobId, jobs.id), inArray(signals.tier, ids))),
      )
    : sql`false`;
  const [summary, tierRows] = await Promise.all([
    db
      .with(latest)
      .select({
        total: sql<number>`count(*)::int`,
        withoutSignal: sql<number>`count(*) filter (where not ${hasTierSignal})::int`,
        highPay: sql<number>`count(*) filter (where ${hasHighValueSignal(db, highValue)})::int`,
        scored: sql<number>`count(${latest.rankValue})::int`,
        avgRank: sql<number | null>`avg(${latest.rankValue})::float8`,
      })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(where),
    db
      .with(latest)
      .select({
        tier: signals.tier,
        jobs: sql<number>`count(distinct ${jobs.id})::int`,
        avgRank: sql<number | null>`avg(${latest.rankValue})::float8`,
      })
      .from(jobs)
      .innerJoin(signals, eq(signals.jobId, jobs.id))
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(and(where, ids ? inArray(signals.tier, ids) : sql`false`))
      .groupBy(signals.tier),
  ]);
  const byTier = new Map(tierRows.map((r) => [r.tier, r]));
  const row = summary[0];
  return {
    total: row?.total ?? 0,
    tiers: categoryIds.map((tier) => ({ tier, jobs: byTier.get(tier)?.jobs ?? 0, avgRank: numOrNull(byTier.get(tier)?.avgRank) })),
    withoutSignal: row?.withoutSignal ?? 0,
    highPay: row?.highPay ?? 0,
    scored: row?.scored ?? 0,
    avgRank: numOrNull(row?.avgRank),
  };
}

/** Rank values of the passed jobs in buckets of `width` points. */
export async function getScoreStats(db: Db, window: InsightsWindow, width: number, capIdx: number, pushMinScore: number): Promise<ScoreStats> {
  const latest = latestScoreCte(db);
  const where = and(firstSeenIn(window), passedOf(latest));
  const [summary, buckets] = await Promise.all([
    db
      .with(latest)
      .select({
        scored: sql<number>`count(${latest.rankValue})::int`,
        atPushLine: sql<number>`count(*) filter (where ${latest.rankValue} >= ${pushMinScore})::int`,
        pending: sql<number>`count(*) filter (where ${latest.rankValue} is null)::int`,
        avgRank: sql<number | null>`avg(${latest.rankValue})::float8`,
      })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(where),
    db
      .with(latest)
      .select({
        index: sql<number>`least(floor(${latest.rankValue} / ${width}::numeric), ${capIdx}::numeric)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(and(where, sql`${latest.rankValue} is not null`))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);
  const row = summary[0];
  return { atPushLine: row?.atPushLine ?? 0, scored: row?.scored ?? 0, pending: row?.pending ?? 0, avgRank: numOrNull(row?.avgRank), buckets };
}

/**
 * The application funnel over the window: passed jobs that appeared, and applications that moved into each
 * stage (or a later one) through a status change inside the window (`application_events`, plus applications
 * whose current status was set inside the window without an event). Counting "or a later one" keeps the funnel
 * monotone when a stage was skipped (interested -> applied).
 */
export async function getFunnelStats(db: Db, window: InsightsWindow): Promise<FunnelStats> {
  const latest = latestScoreCte(db);
  const [newRow] = await db
    .with(latest)
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(firstSeenIn(window), passedOf(latest)));

  const list = (statuses: readonly string[]): SQL => sql.join(statuses.map((s) => sql`${s}`), sql`, `);
  const stageColumns = FUNNEL_STAGES.map((_, i) => sql`count(distinct application_id) filter (where status in (${list(FUNNEL_STAGES.slice(i))}))::int`);
  const exitColumns = FUNNEL_EXITS.map((status) => sql`count(distinct application_id) filter (where status = ${status})::int`);
  const changes = sql`(
    select application_id, to_status::text as status from application_events where at >= ${startOf(window)} and at < ${endOf(window)}
    union
    select id as application_id, status::text as status from applications where status_changed_at >= ${startOf(window)} and status_changed_at < ${endOf(window)}
  ) as changes`;
  const rows = await db.execute<Record<string, number>>(
    sql`select ${sql.join([...stageColumns, ...exitColumns].map((column, i) => sql`${column} as ${sql.identifier(`c${i}`)}`), sql`, `)} from ${changes}`,
  );
  const row = rows[0] ?? {};
  const at = (i: number): number => num(row[`c${i}`]);
  return {
    newJobs: newRow?.n ?? 0,
    reached: Object.fromEntries(FUNNEL_STAGES.map((stage, i) => [stage, at(i)])) as Record<FunnelStage, number>,
    exits: Object.fromEntries(FUNNEL_EXITS.map((status, i) => [status, at(FUNNEL_STAGES.length + i)])) as Record<FunnelExit, number>,
  };
}

/** Why jobs were filtered out: how many filtered-out jobs each reason code applies to, biggest first. */
export async function getFilterStats(db: Db, window: InsightsWindow, limit: number): Promise<FilterStats> {
  const latest = latestScoreCte(db);
  const filteredJobs = and(firstSeenIn(window), filteredOf(latest));
  const exploded = db
    .with(latest)
    .select({ jobId: jobs.id, reason: sql<string>`unnest(${latest.filterReasons})`.as("reason") })
    .from(jobs)
    .innerJoin(latest, eq(latest.jobId, jobs.id))
    .where(filteredJobs)
    .as("exploded");
  const [totalRow, reasons] = await Promise.all([
    db
      .with(latest)
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .innerJoin(latest, eq(latest.jobId, jobs.id))
      .where(filteredJobs),
    db
      .with(latest)
      .select({ code: sql<string>`split_part(${exploded.reason}, ':', 1)`, jobs: sql<number>`count(distinct ${exploded.jobId})::int` })
      .from(exploded)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`, sql`1 asc`)
      .limit(Math.max(1, limit)),
  ]);
  return { total: totalRow[0]?.n ?? 0, reasons };
}

/** Everything /insights shows, from one window of days. The queries are independent and run side by side. */
export async function getInsightsData(db: Db, options: InsightsOptions): Promise<InsightsData> {
  const scoreCap = capIndex(options.scoreBucketCap, options.scoreBucketWidth);
  const salaryCap = capIndex(options.salaryBucketCapEur, options.salaryBucketEur);
  const [daily, previousTotal, previousPassed, sources, cities, salary, signalStats, scores, funnel, filters] = await Promise.all([
    getDailyCounts(db, options.window),
    countJobsFirstSeen(db, options.previous),
    countPassedFirstSeen(db, options.previous),
    getSourceCounts(db, options.window),
    getCityCounts(db, options.window, options.cities, options.cityMembers),
    getSalaryStats(db, options.window, options.salaryBucketEur, salaryCap, options.salaryMinSample, policyCurrency(options.highValue)),
    getSignalStats(db, options.window, options.highValue, options.signalCategoryIds),
    getScoreStats(db, options.window, options.scoreBucketWidth, scoreCap, options.pushMinScore),
    getFunnelStats(db, options.window),
    getFilterStats(db, options.window, options.topFilterReasons),
  ]);
  return { daily, previousTotal, previousPassed, sources, cities, salary, signals: signalStats, scores, funnel, filters, scoreCapIndex: scoreCap, salaryCapIndex: salaryCap };
}
