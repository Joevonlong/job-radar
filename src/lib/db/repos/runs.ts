import { eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { runs } from "../schema";

export type Run = typeof runs.$inferSelect;
export type RunStatus = Run["status"];

export async function createRun(
  db: Db,
  input: { channelId: string; cycleId?: number | null; queryHash?: string | null },
): Promise<Run> {
  const [row] = await db
    .insert(runs)
    .values({ channelId: input.channelId, cycleId: input.cycleId ?? null, queryHash: input.queryHash ?? null })
    .returning();
  if (!row) throw new Error("createRun: insert returned no row");
  return row;
}

export async function finishRun(
  db: Db,
  id: number,
  input: {
    status: Exclude<RunStatus, "running">;
    fetched?: number;
    newCount?: number;
    cost?: number;
    error?: string | null;
    errorCode?: string | null;
  },
): Promise<Run | null> {
  const [row] = await db
    .update(runs)
    .set({
      status: input.status,
      finishedAt: sql`now()`,
      fetched: input.fetched ?? 0,
      newCount: input.newCount ?? 0,
      cost: input.cost ?? 0,
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
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
