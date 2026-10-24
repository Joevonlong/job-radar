import { and, asc, count, desc, eq, exists, gte, inArray, isNull, lte, ne, not, notExists, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { CycleKpiCounts } from "@/lib/dashboard/kpi";
import { readCycleSteps, unprocessedBlocks, type CycleStepStatus } from "@/lib/cycle/step-health";

import type { Db } from "../client";
import { applications, channels, companies, cycles, jobs, notifications, rawPostings, runs, scores } from "../schema";
import type { CycleKind } from "../repos/cycles";
import type { RunStatus } from "../repos/runs";
import { uxTablesReady } from "../repos/ux-tables";
import { FOLLOWING_STATUSES } from "@/lib/applications/following";
import { effectiveStatusSql, manuallyClosedSql } from "./job-status";
import { cardColumns, hideGermanLevels, hydrateCards, latestScoreCte, type CardRow } from "./job-cards";
import { buildJobConditions, hasListableSalary, type JobFilters } from "./jobs";
import { hasHighValueSignal, policyCurrency, type HighValuePolicy } from "./signal-filter";
import { parseSalary } from "./parse";
import type { JobCard } from "./types";
import type { JobSalary } from "@/lib/domain/types";

/** `hasHighValueSignal`, or false without a policy. */
function highValueSql(db: Db, policy: HighValuePolicy | null | undefined): SQL {
  return policy ? hasHighValueSignal(db, policy) : sql`false`;
}

/** `interrupted`: a query failed after some pages (`runs.interrupted`): its postings are stored, but the channel failed. */
export type ChannelOutcome = "ok" | "failed" | "interrupted" | "skipped" | "circuit_open";

/** What one channel did in a cycle (all its runs, one run per query, folded together). */
export interface CycleChannelSummary {
  channelId: string;
  family: string;
  runs: number;
  fetched: number;
  newCount: number;
  outcome: ChannelOutcome;
  /** `ChannelErrorCode` of the first failed, interrupted or skipped run (never of a run that only had invalid records). */
  errorCode: string | null;
  /** While the channel's circuit is open: when one probe run is allowed again. */
  circuitOpenUntil: Date | null;
}

export interface CycleSummary {
  id: number;
  kind: CycleKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  channels: CycleChannelSummary[];
  /** Jobs the cycle created: the pipeline step's `created`, or jobs first seen inside the cycle window when the cycle has no pipeline summary. */
  newCount: number;
  /** Postings the pipeline folded into jobs that already existed (sum of its `merged` rules); null when the cycle has no pipeline summary. */
  mergedCount: number | null;
  /** Raw postings fetched (sum of `runs.fetched`): more than jobs, because sources overlap and postings repeat. */
  fetched: number;
  /** Channels that failed (also after some pages: interrupted) or sit behind an open circuit. */
  failedChannels: number;
  /** Of the jobs first seen while the cycle ran: how many passed the hard filter. */
  passedCount: number;
  /** Of those: how many reach `qualifiedMinRank` (the push threshold); null when no threshold was given. */
  qualifiedCount: number | null;
  /** What each step of the cycle did (`cycles.summary_json`); empty for a cycle without a summary (running, older ones). */
  steps: CycleStepStatus[];
  /** Postings this cycle fetched that no pipeline run has processed yet (still `pending`): after a failed pipeline step they are waiting for the next cycle. */
  unprocessed: number;
}

export interface CycleSummaryOptions {
  /** Rank value from which a new job counts as "qualified" (notify.yaml `push_min_score`). */
  qualifiedMinRank?: number | null;
  /** The lower bar for a job with a high-value signal (notify.yaml `push_min_score_high_value`); default: `qualifiedMinRank`. */
  qualifiedMinRankWithSignals?: number | null;
  /** What makes a job high value (categories, salary floor, other-region pay), so "qualified" matches the push rule; absent = nothing is. */
  highValue?: HighValuePolicy | null;
}

/** The part of `cycles.summary_json` the dashboard reads: the pipeline step's counters. */
const pipelineSummarySchema = z.object({
  steps: z.array(z.object({ name: z.string(), result: z.unknown().optional() })),
});
const pipelineResultSchema = z.object({
  created: z.number().int().nonnegative(),
  merged: z.record(z.string(), z.number().int().nonnegative()),
});

/** `{ created, merged }` of the pipeline step in a cycle's summary, or null when the cycle has none (older cycles, failed or dry runs). */
export function readPipelineCounts(summaryJson: unknown): { created: number; merged: number } | null {
  const summary = pipelineSummarySchema.safeParse(summaryJson);
  if (!summary.success) return null;
  const step = summary.data.steps.find((s) => s.name === "pipeline");
  const result = pipelineResultSchema.safeParse(step?.result);
  if (!result.success) return null;
  return { created: result.data.created, merged: Object.values(result.data.merged).reduce((a, b) => a + b, 0) };
}

/** The most recent cycle that actually ran (a `skipped` cycle did nothing), with what each channel did. Null before the first cycle. */
export async function getLatestCycleSummary(db: Db, options: CycleSummaryOptions = {}): Promise<CycleSummary | null> {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(ne(cycles.status, "skipped"))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(1);
  return cycle ? summarizeCycle(db, cycle, options) : null;
}

/** SQL for the instants a calendar day (in `timezone`) starts and ends. */
function dayBounds(now: Date, timezone: string) {
  const local = sql`date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${timezone})`;
  return { start: sql`(${local} at time zone ${timezone})`, end: sql`((${local} + interval '1 day') at time zone ${timezone})` };
}

/**
 * Every cycle that ran today (calendar day in `timezone`; skipped ones did nothing and are left
 * out), newest first, each with its channels and counts: the Today page lists them so an extra
 * manual run never hides the morning's.
 */
export async function listTodayCycleSummaries(db: Db, options: { now: Date; timezone: string } & CycleSummaryOptions): Promise<CycleSummary[]> {
  const day = dayBounds(options.now, options.timezone);
  const rows = await db
    .select()
    .from(cycles)
    .where(and(ne(cycles.status, "skipped"), sql`${cycles.startedAt} >= ${day.start}`, sql`${cycles.startedAt} < ${day.end}`))
    .orderBy(desc(cycles.startedAt), desc(cycles.id));
  return Promise.all(rows.map((cycle) => summarizeCycle(db, cycle, options)));
}

async function summarizeCycle(db: Db, cycle: typeof cycles.$inferSelect, options: CycleSummaryOptions): Promise<CycleSummary> {
  const rows = await db
    .select({
      run: runs,
      family: channels.family,
      circuitState: channels.circuitState,
      circuitOpenUntil: channels.circuitOpenUntil,
    })
    .from(runs)
    .innerJoin(channels, eq(channels.id, runs.channelId))
    .where(eq(runs.cycleId, cycle.id))
    .orderBy(asc(runs.id));

  const byChannel = new Map<string, CycleChannelSummary>();
  for (const { run, family, circuitState, circuitOpenUntil } of rows) {
    const current =
      byChannel.get(run.channelId) ??
      ({
        channelId: run.channelId,
        family,
        runs: 0,
        fetched: 0,
        newCount: 0,
        outcome: "ok",
        errorCode: null,
        circuitOpenUntil: circuitState === "open" ? circuitOpenUntil : null,
      } satisfies CycleChannelSummary);
    current.runs += 1;
    current.fetched += run.fetched;
    current.newCount += run.newCount;
    // circuit_open > failed > interrupted > skipped > ok; a partial without the marker (some records invalid) is ok
    if (run.status === "failed" && current.outcome !== "circuit_open") current.outcome = "failed";
    if (run.interrupted && (current.outcome === "ok" || current.outcome === "skipped")) current.outcome = "interrupted";
    if (run.status === "skipped" && current.outcome === "ok") current.outcome = "skipped";
    if ((run.status === "failed" || run.status === "skipped" || run.interrupted) && current.errorCode === null) current.errorCode = run.errorCode;
    if (circuitState === "open") current.outcome = "circuit_open";
    byChannel.set(run.channelId, current);
  }
  const summaries = [...byChannel.values()];

  // jobs whose first sighting falls inside this cycle's window: the ones the cycle created
  const windowEnd = cycle.finishedAt ?? sql`now()`;
  const inWindow = and(gte(jobs.firstSeenAt, cycle.startedAt), lte(jobs.firstSeenAt, windowEnd));
  const pipeline = readPipelineCounts(cycle.summaryJson);
  let newCount: number;
  if (pipeline) {
    newCount = pipeline.created;
  } else {
    const [row] = await db.select({ n: count() }).from(jobs).where(inWindow);
    newCount = row?.n ?? 0;
  }

  const latest = latestScoreCte(db);
  const qualifiedMinRank = options.qualifiedMinRank ?? null;
  const qualifiedMinRankWithSignals = options.qualifiedMinRankWithSignals ?? qualifiedMinRank;
  const qualifies =
    qualifiedMinRank === null
      ? sql`false`
      : sql`(${latest.rankValue} >= ${qualifiedMinRank} or (${latest.rankValue} >= ${qualifiedMinRankWithSignals} and ${highValueSql(db, options.highValue)}))`;
  const [outcome] = await db
    .with(latest)
    .select({
      passed: sql<number>`count(*) filter (where ${latest.filterResult} = 'passed')`.mapWith(Number),
      qualified: sql<number>`count(*) filter (where ${latest.filterResult} = 'passed' and ${qualifies})`.mapWith(Number),
    })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    // the cycle's own new jobs, and backlog jobs the AI scored during it ("0 qualified · 2 pushed" for a backlog cycle)
    .where(or(inWindow, sql`exists (select 1 from ${scores} where ${scores.jobId} = ${jobs.id} and ${gte(scores.scoredAt, cycle.startedAt)} and ${lte(scores.scoredAt, windowEnd)})`));

  return {
    id: cycle.id,
    kind: cycle.kind,
    status: cycle.status,
    startedAt: cycle.startedAt,
    finishedAt: cycle.finishedAt,
    channels: summaries,
    newCount,
    mergedCount: pipeline?.merged ?? null,
    fetched: summaries.reduce((sum, c) => sum + c.fetched, 0),
    failedChannels: summaries.filter((c) => c.outcome === "failed" || c.outcome === "interrupted" || c.outcome === "circuit_open").length,
    passedCount: outcome?.passed ?? 0,
    qualifiedCount: qualifiedMinRank === null ? null : (outcome?.qualified ?? 0),
    steps: readCycleSteps(cycle.summaryJson),
    unprocessed: await countCyclePending(db, cycle.id),
  };
}

/** Raw postings first stored by the cycle's runs that the pipeline has not handled (`pending`): the next cycle's pipeline step picks every pending posting up. */
async function countCyclePending(db: Db, cycleId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(rawPostings)
    .where(and(eq(rawPostings.parseStatus, "pending"), inArray(rawPostings.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.cycleId, cycleId)))));
  return row?.n ?? 0;
}

/** The filters of a saved view that the Today list takes on top of its own (the date range is today, the toggles have their own options). */
export type TodayExtraFilters = Pick<JobFilters, "q" | "qLocationTerms" | "sources" | "companyIds" | "cities" | "cityMembers" | "workplaces" | "contracts" | "statuses" | "applicationStatuses" | "minRank" | "minAnnualSalary" | "salaryDisclosed" | "trap" | "visa" | "ghost">;

export interface TodayOptions {
  /** "Now": the day is the calendar day of this instant in `timezone`. */
  now: Date;
  timezone: string;
  /**
   * The latest cycle that ran (`getLatestCycleSummary`): its new jobs belong on the list too, also when they were first seen
   * before today began (the evening cycle's jobs are still "this round" the next morning). Null / absent = today only.
   */
  cycle?: { startedAt: Date; finishedAt: Date | null } | null;
  /** Include jobs the hard filter removed (they sort last). */
  includeFiltered?: boolean;
  /** Hide jobs requiring one of these German levels (quick filter). */
  hideGermanLevels?: readonly string[];
  /** Only jobs with a high-value signal (the "high-value signals only" quick filter); null / absent = no filter. */
  highValueOnly?: boolean;
  /** What makes a job high value: the quick filter above and the "high score" quick view's lower line. */
  highValue?: HighValuePolicy | null;
  /** More filters of a saved view, the same ones /jobs has; the date range does not apply (it is today). */
  /** One of the built-in quick views (needs `quickLines`); null / absent = the whole list. */
  quick?: Exclude<QuickView, "all"> | null;
  /** The push lines the "high score" view means (notify.yaml `push_min_score` / `push_min_score_high_value`). */
  quickLines?: QuickLines;
  extra?: TodayExtraFilters;
  /** Load the visa badge data (`hydrateCards`); false when the badge is hidden. Default true. */
  visa?: boolean;
  /** Load the ghost job marks (`hydrateCards`); only when the check is on. Default false. */
  ghost?: boolean;
}

/**
 * The Today list: jobs first seen today (calendar day in `timezone`) or inside the latest cycle's window (`options.cycle`, the same
 * window `listCycleNewJobs` and the KPI strip count), best rank first, unranked ones by first-seen time. Ignored jobs (application
 * status `archived`) are hidden, and so are filtered-out ones unless asked for.
 */
export async function listTodayJobs(db: Db, options: TodayOptions): Promise<JobCard[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const conditions = todayConditions(db, options, latest, ux);
  if (options.quick) conditions.push(quickCondition(db, latest, options.quick, options.quickLines ?? { qualifiedMinRank: null, qualifiedMinRankWithSignals: null }, options.highValue));

  const rows: CardRow[] = await db
    .with(latest)
    .select(cardColumns(latest, ux))
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(...conditions))
    .orderBy(sql`coalesce(${latest.filterResult} = 'filtered_out', false) asc`, sql`${latest.rankValue} desc nulls last`, sql`${jobs.postedAt} desc nulls last`, desc(jobs.firstSeenAt), desc(jobs.id));
  return hydrateCards(db, rows, { visa: options.visa ?? true, ghost: options.ghost === true });
}

/** The conditions that select the Today list (the window, ignored / filtered-out jobs, the toggles and the saved view's filters); the quick view is added by the caller. */
function todayConditions(db: Db, options: TodayOptions, latest: ReturnType<typeof latestScoreCte>, ux: boolean): SQL[] {
  const { start: dayStart, end: dayEnd } = dayBounds(options.now, options.timezone);

  const today = and(sql`${jobs.firstSeenAt} >= ${dayStart}`, sql`${jobs.firstSeenAt} < ${dayEnd}`);
  const cycleWindow = options.cycle ? and(gte(jobs.firstSeenAt, options.cycle.startedAt), lte(jobs.firstSeenAt, options.cycle.finishedAt ?? sql`now()`)) : undefined;
  const conditions: SQL[] = [(cycleWindow ? or(today, cycleWindow) : today) ?? sql`true`];
  // ignored jobs stay out, unless a saved view asks for them by status
  if (!options.extra?.applicationStatuses?.includes("archived")) {
    conditions.push(notExists(db.select({ one: sql`1` }).from(applications).where(and(eq(applications.jobId, jobs.id), eq(applications.status, "archived")))));
  }
  if (options.highValueOnly && options.highValue) conditions.push(hasHighValueSignal(db, options.highValue));
  if (!options.includeFiltered) {
    const visible = or(isNull(latest.filterResult), ne(latest.filterResult, "filtered_out"));
    if (visible) conditions.push(visible);
  }
  // Jobs that show as closed stay out, unless a saved view asks for a job status (possibly closed ones stay)
  if (!options.extra?.statuses || options.extra.statuses.length === 0) conditions.push(sql`${effectiveStatusSql(ux)} <> 'closed'`);
  const german = hideGermanLevels(latest, options.hideGermanLevels ?? []);
  if (german) conditions.push(german);
  const extra = options.extra ? buildJobConditions(db, options.extra, options.timezone, latest, ux) : undefined;
  if (extra) conditions.push(extra);
  return conditions;
}

/** The built-in quick views of Today: all new jobs, high score (at or above the push line), salary stated, and the ones being followed up. */
export const QUICK_VIEWS = ["all", "high", "salary", "following"] as const;
export type QuickView = (typeof QUICK_VIEWS)[number];


function quickCondition(db: Db, latest: ReturnType<typeof latestScoreCte>, view: Exclude<QuickView, "all">, lines: QuickLines, policy?: HighValuePolicy | null): SQL {
  switch (view) {
    case "high": {
      // the same rule as the summary block "at or above the push line" and the Telegram push
      if (lines.qualifiedMinRank === null) return sql`false`;
      const withSignals = lines.qualifiedMinRankWithSignals ?? lines.qualifiedMinRank;
      return sql`(${latest.rankValue} >= ${lines.qualifiedMinRank} or (${latest.rankValue} >= ${withSignals} and ${highValueSql(db, policy)}))`;
    }
    case "salary":
      return hasListableSalary(policyCurrency(policy ?? undefined));
    case "following":
      return exists(db.select({ one: sql`1` }).from(applications).where(and(eq(applications.jobId, jobs.id), inArray(applications.status, [...FOLLOWING_STATUSES]))));
  }
}

export interface QuickLines {
  qualifiedMinRank: number | null;
  qualifiedMinRankWithSignals?: number | null;
}

/**
 * How many jobs each tab of the Today view switch holds, in one query over the same selection as the list: the four built-in
 * quick views. A saved view has its own count (`countTodayJobs`).
 */
export async function countTodayQuickViews(db: Db, options: Omit<TodayOptions, "extra" | "quick"> & { quickLines: QuickLines }): Promise<Record<QuickView, number>> {
  const latest = latestScoreCte(db);
  const conditions = todayConditions(db, options, latest, await uxTablesReady(db));
  const [row] = await db
    .with(latest)
    .select({
      all: sql<number>`count(*)`.mapWith(Number),
      high: sql<number>`count(*) filter (where ${quickCondition(db, latest, "high", options.quickLines, options.highValue)})`.mapWith(Number),
      salary: sql<number>`count(*) filter (where ${quickCondition(db, latest, "salary", options.quickLines, options.highValue)})`.mapWith(Number),
      following: sql<number>`count(*) filter (where ${quickCondition(db, latest, "following", options.quickLines, options.highValue)})`.mapWith(Number),
    })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(...conditions));
  return { all: row?.all ?? 0, high: row?.high ?? 0, salary: row?.salary ?? 0, following: row?.following ?? 0 };
}

/** The number of jobs `listTodayJobs` would list for these options (a saved view's tab). */
export async function countTodayJobs(db: Db, options: TodayOptions): Promise<number> {
  const latest = latestScoreCte(db);
  const [row] = await db
    .with(latest)
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(...todayConditions(db, options, latest, await uxTablesReady(db))));
  return row?.n ?? 0;
}

/**
 * Counts of the last cycles for the summary blocks of Today, oldest first (the last one is `getLatestCycleSummary`'s cycle). One query:
 * every cycle (skipped ones did nothing and are left out) joins the jobs it handled, the same set `summarizeCycle` uses (first seen
 * inside the cycle window, or scored during it), and is grouped by cycle.
 *
 * - `fetched`: postings fetched, the sum of `runs.fetched`
 * - `passed`: of those jobs, how many passed the hard filter
 * - `qualified`: of the passed ones, how many reach the push score (`qualifiedMinRank` / with a high-value signal `qualifiedMinRankWithSignals`);
 *   null when no push line is given
 * - `salaryStated`: of the passed ones, how many state a salary the list can draw (`hasListableSalary`)
 * - `pushed`: job messages sent to Telegram for the cycle (`notifications` of kind `job` with a send time)
 */
export async function listRecentCycleKpis(db: Db, options: CycleSummaryOptions & { limit: number }): Promise<Array<CycleKpiCounts & { startedAt: Date }>> {
  const recent = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(ne(cycles.status, "skipped"))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(Math.max(1, options.limit));
  if (recent.length === 0) return [];

  const latest = latestScoreCte(db);
  const qualifiedMinRank = options.qualifiedMinRank ?? null;
  const qualifiedMinRankWithSignals = options.qualifiedMinRankWithSignals ?? qualifiedMinRank;
  const windowEnd = sql`coalesce(${cycles.finishedAt}, now())`;
  const handled = or(
    and(gte(jobs.firstSeenAt, cycles.startedAt), sql`${jobs.firstSeenAt} <= ${windowEnd}`),
    sql`exists (select 1 from ${scores} where ${scores.jobId} = ${jobs.id} and ${scores.scoredAt} >= ${cycles.startedAt} and ${scores.scoredAt} <= ${windowEnd})`,
  );
  const qualifies =
    qualifiedMinRank === null
      ? sql`false`
      : sql`(${latest.rankValue} >= ${qualifiedMinRank} or (${latest.rankValue} >= ${qualifiedMinRankWithSignals} and ${highValueSql(db, options.highValue)}))`;
  const rows = await db
    .with(latest)
    .select({
      id: cycles.id,
      startedAt: cycles.startedAt,
      fetched: sql<number>`(select coalesce(sum(${runs.fetched}), 0) from ${runs} where ${runs.cycleId} = ${cycles.id})`.mapWith(Number),
      pushed: sql<number>`(select count(*) from ${notifications} where ${notifications.cycleId} = ${cycles.id} and ${notifications.kind} = 'job' and ${notifications.sentAt} is not null)`.mapWith(Number),
      passed: sql<number>`count(${jobs.id}) filter (where ${latest.filterResult} = 'passed')`.mapWith(Number),
      qualified: sql<number>`count(${jobs.id}) filter (where ${latest.filterResult} = 'passed' and ${qualifies})`.mapWith(Number),
      salaryStated: sql<number>`count(${jobs.id}) filter (where ${latest.filterResult} = 'passed' and ${hasListableSalary(policyCurrency(options.highValue ?? undefined))})`.mapWith(Number),
      unprocessed: sql<number>`(select count(*) from ${rawPostings} where ${rawPostings.parseStatus} = 'pending' and ${rawPostings.runId} in (select ${runs.id} from ${runs} where ${runs.cycleId} = ${cycles.id}))`.mapWith(Number),
      summaryJson: cycles.summaryJson,
    })
    .from(cycles)
    .leftJoin(jobs, handled)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(inArray(
      cycles.id,
      recent.map((row) => row.id),
    ))
    .groupBy(cycles.id, cycles.startedAt)
    .orderBy(asc(cycles.startedAt), asc(cycles.id));
  return rows.map((row) => {
    const steps = readCycleSteps(row.summaryJson);
    return {
      cycleId: row.id,
      startedAt: row.startedAt,
      fetched: row.fetched,
      passed: row.passed,
      qualified: qualifiedMinRank === null ? null : row.qualified,
      salaryStated: row.salaryStated,
      pushed: row.pushed,
      unprocessed: row.unprocessed,
      unprocessedBlocks: unprocessedBlocks(steps),
    };
  });
}

/** One new job of a cycle, as the ticker prints it. */
export interface CycleNewJob {
  id: number;
  title: string;
  companyName: string;
  salary: JobSalary | null;
  /** Rank value; null = not scored yet. */
  rankValue: number | null;
}

/**
 * The jobs a cycle created (first seen inside its window), best rank first, not hard-filtered and not ignored: the ticker of Today
 * scrolls them. At most `limit`.
 */
export async function listCycleNewJobs(db: Db, cycle: { startedAt: Date; finishedAt: Date | null }, limit: number): Promise<CycleNewJob[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const windowEnd = cycle.finishedAt ?? sql`now()`;
  const rows = await db
    .with(latest)
    .select({ id: jobs.id, title: jobs.title, companyName: companies.name, salaryJson: jobs.salaryJson, rankValue: latest.rankValue })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(
      and(
        gte(jobs.firstSeenAt, cycle.startedAt),
        lte(jobs.firstSeenAt, windowEnd),
        or(isNull(latest.filterResult), ne(latest.filterResult, "filtered_out")),
        notExists(db.select({ one: sql`1` }).from(applications).where(and(eq(applications.jobId, jobs.id), eq(applications.status, "archived")))),
        // A job the user closed is not news
        ux ? not(manuallyClosedSql()) : undefined,
      ),
    )
    .orderBy(sql`${latest.rankValue} desc nulls last`, desc(jobs.firstSeenAt), desc(jobs.id))
    .limit(Math.max(0, limit));
  return rows.map((row) => ({ id: row.id, title: row.title, companyName: row.companyName, salary: parseSalary(row.salaryJson), rankValue: row.rankValue }));
}
