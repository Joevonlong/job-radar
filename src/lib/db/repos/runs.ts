import { eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { runs } from "../schema";
import { setLocalWriteTimeout } from "../write-timeout";

export type Run = typeof runs.$inferSelect;
export type RunStatus = Run["status"];

export async function createRun(
  db: Db,
  input: { channelId: string; cycleId?: number | null; queryHash?: string | null; windowHours?: number | null; windowExtended?: boolean },
): Promise<Run> {
  const [row] = await db
    .insert(runs)
    .values({
      channelId: input.channelId,
      cycleId: input.cycleId ?? null,
      queryHash: input.queryHash ?? null,
      windowHours: input.windowHours ?? null,
      windowExtended: input.windowExtended ?? false,
    })
    .returning();
  if (!row) throw new Error("createRun: insert returned no row");
  return row;
}

export interface FinishRunFields {
  status: Exclude<RunStatus, "running">;
  fetched?: number;
  newCount?: number;
  cost?: number;
  usageUnits?: number;
  error?: string | null;
  errorCode?: string | null;
  /** The query failed after some pages; what they returned was stored. */
  interrupted?: boolean;
}

export async function finishRun(db: Db, id: number, input: FinishRunFields, writeTimeoutMs?: number): Promise<Run | null> {
  if (writeTimeoutMs !== undefined) {
    return db.transaction(async (tx) => {
      await setLocalWriteTimeout(tx, writeTimeoutMs);
      return finishRunWithExecutor(tx, id, input);
    });
  }
  return finishRunWithExecutor(db, id, input);
}

/** Shared finish fields for a standalone update or an enclosing repository transaction. */
export async function finishRunWithExecutor(db: Executor, id: number, input: FinishRunFields): Promise<Run | null> {
  const [row] = await db
    .update(runs)
    .set({
      status: input.status,
      finishedAt: sql`now()`,
      fetched: input.fetched ?? 0,
      newCount: input.newCount ?? 0,
      cost: input.cost ?? 0,
      usageUnits: input.usageUnits ?? 0,
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      interrupted: input.interrupted ?? false,
    })
    .where(eq(runs.id, id))
    .returning();
  return row ?? null;
}

export async function getRun(db: Db, id: number): Promise<Run | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

export async function listRunsForCycle(db: Db, cycleId: number): Promise<Run[]> {
  return db.select().from(runs).where(eq(runs.cycleId, cycleId)).orderBy(runs.id);
}

export interface QueryRunHistoryRow {
  channelId: string;
  queryHash: string;
  lastTurnAt: Date | null;
  lastCoveredAt: Date | null;
  firstSeenAt: Date;
}

/** Every run except an empty, unspent skip is a turn; coverage requires success, uninterrupted partial, or a spent/nonempty skip. */
export async function getQueryRunHistory(
  db: Db,
  args: { channelIds: readonly string[]; queryHashes: readonly string[] },
): Promise<QueryRunHistoryRow[]> {
  if (args.channelIds.length === 0 || args.queryHashes.length === 0) return [];
  const rows = await db.select({
    channelId: runs.channelId,
    queryHash: sql<string>`${runs.queryHash}`,
    lastTurnAt: sql<string | null>`max(${runs.startedAt}) filter (where not (
      ${runs.status} = 'skipped' and ${runs.fetched} = 0 and ${runs.usageUnits} = 0 and ${runs.cost} = 0))`,
    lastCoveredAt: sql<string | null>`max(${runs.startedAt}) filter (where
      ${runs.status} = 'succeeded' or (${runs.status} = 'partial' and not ${runs.interrupted})
      or (${runs.status} = 'skipped' and (${runs.fetched} > 0 or ${runs.usageUnits} > 0 or ${runs.cost} > 0)))`,
    firstSeenAt: sql<string>`min(${runs.startedAt})`,
  }).from(runs).where(sql`${runs.channelId} = any(${sql.param([...args.channelIds])}::text[])
    and ${runs.queryHash} = any(${sql.param([...args.queryHashes])}::text[])`).groupBy(runs.channelId, runs.queryHash);
  return rows.map((row) => ({
    ...row,
    lastTurnAt: row.lastTurnAt === null ? null : new Date(row.lastTurnAt),
    lastCoveredAt: row.lastCoveredAt === null ? null : new Date(row.lastCoveredAt),
    firstSeenAt: new Date(row.firstSeenAt),
  }));
}
