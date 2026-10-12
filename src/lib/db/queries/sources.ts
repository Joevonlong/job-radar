import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";

import { readCycleSteps, type CycleStepStatus } from "@/lib/cycle/step-health";

import type { Db } from "../client";
import { aiUsage, channels, cycles, rawPostings, runs } from "../schema";
import type { CycleKind } from "../repos/cycles";
import type { RunStatus } from "../repos/runs";

/** Data behind `/sources` and the progress line of `/settings`: plain reads, no interpretation. */

export interface ChannelStateRow {
  id: string;
  family: string;
  kind: string;
  health: "unknown" | "healthy" | "degraded" | "down";
  circuitState: "closed" | "open" | "half_open";
  circuitOpenUntil: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastSuccessAt: Date | null;
}

/** Every row of `channels` (the runner keeps one per channel it has registered). */
export async function listChannelStates(db: Db): Promise<ChannelStateRow[]> {
  return db
    .select({
      id: channels.id,
      family: channels.family,
      kind: channels.kind,
      health: channels.health,
      circuitState: channels.circuitState,
      circuitOpenUntil: channels.circuitOpenUntil,
      consecutiveFailures: channels.consecutiveFailures,
      lastErrorCode: channels.lastErrorCode,
      lastSuccessAt: channels.lastSuccessAt,
    })
    .from(channels)
    .orderBy(asc(channels.id));
}

export interface RecentRun {
  id: number;
  cycleId: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: RunStatus;
  fetched: number;
  newCount: number;
  cost: number;
  errorCode: string | null;
  error: string | null;
  /** The query failed after some pages (`status` is `partial`, the failure in `errorCode`); false for a partial with invalid records. */
  interrupted: boolean;
}

/** The newest `perChannel` runs of every channel, newest first within a channel. */
export async function listRecentRunsByChannel(db: Db, perChannel: number): Promise<Map<string, RecentRun[]>> {
  const ranked = db
    .select({
      id: runs.id,
      channelId: runs.channelId,
      cycleId: runs.cycleId,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      status: runs.status,
      fetched: runs.fetched,
      newCount: runs.newCount,
      cost: runs.cost,
      errorCode: runs.errorCode,
      error: runs.error,
      interrupted: runs.interrupted,
      rank: sql<number>`row_number() over (partition by ${runs.channelId} order by ${runs.startedAt} desc, ${runs.id} desc)`.as("rank"),
    })
    .from(runs)
    .as("ranked");
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, perChannel))
    .orderBy(asc(ranked.channelId), desc(ranked.startedAt), desc(ranked.id));
  const byChannel = new Map<string, RecentRun[]>();
  for (const { rank: _rank, channelId, ...run } of rows) {
    void _rank;
    const list = byChannel.get(channelId) ?? [];
    list.push(run);
    byChannel.set(channelId, list);
  }
  return byChannel;
}

export interface CycleChannelRuns {
  channelId: string;
  family: string;
  runs: number;
  /** Runs that answered: succeeded, or partial with some invalid records. */
  succeeded: number;
  failed: number;
  skipped: number;
  /** Partial runs whose query failed after some pages (`runs.interrupted`): postings kept, but a failure, never a success. */
  interrupted: number;
  fetched: number;
}

export interface LatestCycleRuns {
  id: number;
  kind: CycleKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  channels: CycleChannelRuns[];
  /** What each step of the cycle did (`cycles.summary_json`); absent / empty for a cycle without a summary. */
  steps?: CycleStepStatus[];
  /** Postings the cycle fetched that are still waiting for the pipeline. */
  unprocessed?: number;
}

/** The most recent cycle that actually ran (not `skipped`) with its runs folded per channel; null before the first cycle. */
export async function getLatestCycleRuns(db: Db): Promise<LatestCycleRuns | null> {
  const [cycle] = await db
    .select({ id: cycles.id, kind: cycles.kind, status: cycles.status, startedAt: cycles.startedAt, finishedAt: cycles.finishedAt, summaryJson: cycles.summaryJson })
    .from(cycles)
    .where(ne(cycles.status, "skipped"))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(1);
  if (!cycle) return null;
  const rows = await db
    .select({
      channelId: runs.channelId,
      family: channels.family,
      runs: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} in ('succeeded', 'partial') and not ${runs.interrupted})::int`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
      skipped: sql<number>`count(*) filter (where ${runs.status} = 'skipped')::int`,
      interrupted: sql<number>`count(*) filter (where ${runs.interrupted})::int`,
      fetched: sql<number>`coalesce(sum(${runs.fetched}), 0)::int`,
    })
    .from(runs)
    .innerJoin(channels, eq(channels.id, runs.channelId))
    .where(eq(runs.cycleId, cycle.id))
    .groupBy(runs.channelId, channels.family)
    .orderBy(asc(runs.channelId));
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rawPostings)
    .where(and(eq(rawPostings.parseStatus, "pending"), inArray(rawPostings.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.cycleId, cycle.id)))));
  const { summaryJson, ...rest } = cycle;
  return { ...rest, channels: rows, steps: readCycleSteps(summaryJson), unprocessed: pending?.n ?? 0 };
}

export interface MonthRunTotals {
  /** Runs started in the month (one run per query). */
  runs: number;
  /** Raw postings the runs fetched. */
  fetched: number;
  /** Postings that were new when the run saw them. */
  newCount: number;
}

/**
 * What every channel did in the calendar month `month` (`YYYY-MM` in `timeZone`), counted from its runs: the
 * activity of channels that have no budget to count against (the ATS boards, Indeed, the Arbeitsagentur), so their
 * card shows real figures too. Channels without a run in the month are absent.
 */
export async function getMonthRunTotals(db: Db, args: { month: string; timeZone: string }): Promise<Map<string, MonthRunTotals>> {
  const rows = await db
    .select({
      channelId: runs.channelId,
      runs: sql<number>`count(*)::int`,
      fetched: sql<number>`coalesce(sum(${runs.fetched}), 0)::int`,
      newCount: sql<number>`coalesce(sum(${runs.newCount}), 0)::int`,
    })
    .from(runs)
    .where(and(sql`to_char(${runs.startedAt} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`, ne(runs.status, "skipped")))
    .groupBy(runs.channelId);
  return new Map(rows.map(({ channelId, ...totals }) => [channelId, totals]));
}

export interface AiUsageRow {
  provider: string;
  task: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** `ai_usage` of the calendar month `month` (`YYYY-MM` in `timeZone`), per provider and task. */
export async function getAiUsageForMonth(db: Db, args: { month: string; timeZone: string }): Promise<AiUsageRow[]> {
  const rows = await db
    .select({
      provider: aiUsage.provider,
      task: aiUsage.task,
      calls: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiUsage.tokensIn}), 0)::bigint`,
      tokensOut: sql<number>`coalesce(sum(${aiUsage.tokensOut}), 0)::bigint`,
      costUsd: sql<string>`coalesce(sum(${aiUsage.costEstimate}), 0)`,
    })
    .from(aiUsage)
    .where(sql`to_char(${aiUsage.at} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`)
    .groupBy(aiUsage.provider, aiUsage.task)
    .orderBy(asc(aiUsage.provider), asc(aiUsage.task));
  return rows.map((row) => ({ ...row, tokensIn: Number(row.tokensIn), tokensOut: Number(row.tokensOut), costUsd: Number(row.costUsd) }));
}

/** When each provider last had a call that came back (failed calls are recorded but do not count; legacy rows have no outcome and do). */
export async function getLastAiUsageAt(db: Db): Promise<Map<string, Date>> {
  const rows = await db
    .select({ provider: aiUsage.provider, at: sql<Date>`max(${aiUsage.at})` })
    .from(aiUsage)
    .where(sql`${aiUsage.outcome} is distinct from 'failed'`)
    .groupBy(aiUsage.provider);
  return new Map(rows.map((row) => [row.provider, new Date(row.at)]));
}

export interface CycleProgress {
  id: number;
  kind: CycleKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  runsTotal: number;
  runsFinished: number;
  fetched: number;
  newCount: number;
}

/** Progress of one cycle: how many of its runs have finished, and what they brought in so far. */
export async function getCycleProgress(db: Db, cycleId: number): Promise<CycleProgress | null> {
  const [cycle] = await db
    .select({ id: cycles.id, kind: cycles.kind, status: cycles.status, startedAt: cycles.startedAt, finishedAt: cycles.finishedAt })
    .from(cycles)
    .where(eq(cycles.id, cycleId))
    .limit(1);
  if (!cycle) return null;
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      finished: sql<number>`count(*) filter (where ${runs.status} <> 'running')::int`,
      fetched: sql<number>`coalesce(sum(${runs.fetched}), 0)::int`,
      fresh: sql<number>`coalesce(sum(${runs.newCount}), 0)::int`,
    })
    .from(runs)
    .where(eq(runs.cycleId, cycleId));
  return { ...cycle, runsTotal: row?.total ?? 0, runsFinished: row?.finished ?? 0, fetched: row?.fetched ?? 0, newCount: row?.fresh ?? 0 };
}

/** The first `manual` cycle that started at or after `since` (a manual request's cycle while its id is not recorded yet). */
export async function findManualCycleSince(db: Db, since: Date): Promise<number | null> {
  const [row] = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(and(eq(cycles.kind, "manual"), gte(cycles.startedAt, since), ne(cycles.status, "skipped")))
    .orderBy(asc(cycles.startedAt), asc(cycles.id))
    .limit(1);
  return row?.id ?? null;
}

/** What one channel did in one cycle, folded from its runs (a cycle has one run per query). */
export interface ChannelCycleStat {
  cycleId: number;
  runs: number;
  succeeded: number;
  /** Partial runs that answered with some invalid records (not the interrupted ones). */
  partial: number;
  failed: number;
  skipped: number;
  /** Partial runs whose query failed after some pages (`runs.interrupted`). */
  interrupted: number;
  running: number;
  fetched: number;
  newCount: number;
}

/**
 * Per channel, the last `count` cycles (oldest first, the same cycles for every channel, so the strips line up):
 * `null` where the channel had no run in that cycle. Cycles that were skipped as a whole are not counted. One
 * query: the cycle window is crossed with the channels, the runs are folded per (channel, cycle) and the
 * per-cycle figures come back as aligned arrays per channel (`array_agg ... order by`).
 */
export async function listChannelCycleHistory(db: Db, count: number): Promise<Map<string, (ChannelCycleStat | null)[]>> {
  if (count <= 0) return new Map();
  const rows = await db.execute<{
    channel_id: string;
    cycle_ids: number[];
    runs: number[];
    succeeded: number[];
    partial: number[];
    failed: number[];
    skipped: number[];
    interrupted: number[];
    running: number[];
    fetched: number[];
    new_count: number[];
  }>(sql`
    with win as (
      select id, started_at from ${cycles} where status <> 'skipped' order by started_at desc, id desc limit ${count}
    ),
    per as (
      select r.channel_id, r.cycle_id,
        count(*)::int as runs,
        count(*) filter (where r.status = 'succeeded')::int as succeeded,
        count(*) filter (where r.status = 'partial' and not r.interrupted)::int as partial,
        count(*) filter (where r.status = 'failed')::int as failed,
        count(*) filter (where r.status = 'skipped')::int as skipped,
        count(*) filter (where r.interrupted)::int as interrupted,
        count(*) filter (where r.status = 'running')::int as running,
        coalesce(sum(r.fetched), 0)::int as fetched,
        coalesce(sum(r.new_count), 0)::int as new_count
      from ${runs} r
      where r.cycle_id in (select id from win)
      group by r.channel_id, r.cycle_id
    )
    select g.channel_id,
      array_agg(g.cycle_id order by g.started_at, g.cycle_id) as cycle_ids,
      array_agg(coalesce(p.runs, 0) order by g.started_at, g.cycle_id) as runs,
      array_agg(coalesce(p.succeeded, 0) order by g.started_at, g.cycle_id) as succeeded,
      array_agg(coalesce(p.partial, 0) order by g.started_at, g.cycle_id) as partial,
      array_agg(coalesce(p.failed, 0) order by g.started_at, g.cycle_id) as failed,
      array_agg(coalesce(p.skipped, 0) order by g.started_at, g.cycle_id) as skipped,
      array_agg(coalesce(p.interrupted, 0) order by g.started_at, g.cycle_id) as interrupted,
      array_agg(coalesce(p.running, 0) order by g.started_at, g.cycle_id) as running,
      array_agg(coalesce(p.fetched, 0) order by g.started_at, g.cycle_id) as fetched,
      array_agg(coalesce(p.new_count, 0) order by g.started_at, g.cycle_id) as new_count
    from (select c.id as channel_id, w.id as cycle_id, w.started_at from ${channels} c cross join win w) g
    left join per p on p.channel_id = g.channel_id and p.cycle_id = g.cycle_id
    group by g.channel_id
  `);
  const out = new Map<string, (ChannelCycleStat | null)[]>();
  for (const row of rows) {
    out.set(
      row.channel_id,
      row.cycle_ids.map((cycleId, i) =>
        (row.runs[i] ?? 0) === 0
          ? null
          : {
              cycleId: Number(cycleId),
              runs: row.runs[i] ?? 0,
              succeeded: row.succeeded[i] ?? 0,
              partial: row.partial[i] ?? 0,
              failed: row.failed[i] ?? 0,
              skipped: row.skipped[i] ?? 0,
              interrupted: row.interrupted[i] ?? 0,
              running: row.running[i] ?? 0,
              fetched: row.fetched[i] ?? 0,
              newCount: row.new_count[i] ?? 0,
            },
      ),
    );
  }
  return out;
}
