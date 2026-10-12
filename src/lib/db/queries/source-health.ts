import { and, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { atsBoards, rawPostings, runs } from "../schema";
import type { RunStatus } from "../repos/runs";

/** Health data behind the source registry: plain reads, interpreted by `src/lib/sources/registry/status.ts`. */

export interface ChannelWindowStat {
  /** Runs started since the window start. */
  runs: number;
  /** Failed runs, counting a query cut short after some pages (`interrupted`) as failed. */
  failed: number;
  fetched: number;
  newCount: number;
  /** The newest run of the channel at all (not only inside the window); null when it never ran. */
  lastRun: { startedAt: Date; finishedAt?: Date | null; status: RunStatus; errorCode: string | null; interrupted: boolean } | null;
}

/** Per channel: run counts of the window and the latest run. Channels that never ran are not in the map. */
export async function getChannelWindowStats(db: Db, args: { since: Date }): Promise<Map<string, ChannelWindowStat>> {
  const windowRows = await db
    .select({
      channelId: runs.channelId,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed' or ${runs.interrupted})::int`,
      fetched: sql<number>`coalesce(sum(${runs.fetched}), 0)::int`,
      newCount: sql<number>`coalesce(sum(${runs.newCount}), 0)::int`,
    })
    .from(runs)
    .where(gte(runs.startedAt, args.since))
    .groupBy(runs.channelId);
  const lastRows = await db
    .selectDistinctOn([runs.channelId], { channelId: runs.channelId, startedAt: runs.startedAt, finishedAt: runs.finishedAt, status: runs.status, errorCode: runs.errorCode, interrupted: runs.interrupted })
    .from(runs)
    .orderBy(runs.channelId, sql`${runs.startedAt} desc`, sql`${runs.id} desc`);
  const stats = new Map<string, ChannelWindowStat>();
  for (const row of lastRows) {
    stats.set(row.channelId, { runs: 0, failed: 0, fetched: 0, newCount: 0, lastRun: { startedAt: row.startedAt, finishedAt: row.finishedAt, status: row.status, errorCode: row.errorCode, interrupted: row.interrupted } });
  }
  for (const row of windowRows) {
    const existing = stats.get(row.channelId);
    stats.set(row.channelId, { ...(existing ?? { lastRun: null }), runs: row.runs, failed: row.failed, fetched: row.fetched, newCount: row.newCount });
  }
  return stats;
}

export interface BoardHealthRow {
  ats: string;
  token: string;
  lastStatus: string;
  lastErrorCode: string | null;
  lastCheckedAt: Date;
  lastOkAt: Date | null;
  consecutiveFailures: number;
  lastTotal: number;
  lastKept: number;
}

/** Every board that was checked at least once. */
export async function listBoardHealth(db: Db): Promise<BoardHealthRow[]> {
  return db
    .select({
      ats: atsBoards.ats,
      token: atsBoards.token,
      lastStatus: atsBoards.lastStatus,
      lastErrorCode: atsBoards.lastErrorCode,
      lastCheckedAt: atsBoards.lastCheckedAt,
      lastOkAt: atsBoards.lastOkAt,
      consecutiveFailures: atsBoards.consecutiveFailures,
      lastTotal: atsBoards.lastTotal,
      lastKept: atsBoards.lastKept,
    })
    .from(atsBoards);
}

/**
 * Postings of the ATS channels `atsIds` returned since `since`, per board: the board is read from the stored envelope
 * (`payload_json.source.ats` / `.token`). Key `${ats}:${token}`.
 */
export async function getBoardSeenCounts(db: Db, args: { since: Date; atsIds: readonly string[] }): Promise<Map<string, number>> {
  if (args.atsIds.length === 0) return new Map();
  const ats = sql<string>`${rawPostings.payloadJson} #>> '{source,ats}'`;
  const token = sql<string>`${rawPostings.payloadJson} #>> '{source,token}'`;
  const rows = await db
    .select({ ats, token, n: sql<number>`count(*)::int` })
    .from(rawPostings)
    .where(and(inArray(rawPostings.channelId, [...args.atsIds]), gte(rawPostings.fetchedAt, args.since)))
    .groupBy(ats, token);
  const counts = new Map<string, number>();
  for (const row of rows) if (row.ats && row.token) counts.set(`${row.ats}:${row.token}`, row.n);
  return counts;
}
