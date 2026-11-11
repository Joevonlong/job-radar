/** Bounded operations reads; the MCP projection is defined separately from database rows. */
import { desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { cycles, runs, controlRequestKindEnum } from "../schema";
import { countOpenControlRequests } from "../repos/control-requests";

export function listOpsCycles(db: Db, limit: number) {
  return db.select().from(cycles).orderBy(desc(cycles.startedAt), desc(cycles.id)).limit(limit);
}

export function listOpsRuns(db: Db, cycleId: number, limit: number) {
  return db.select().from(runs).where(eq(runs.cycleId, cycleId)).orderBy(desc(runs.startedAt), desc(runs.id)).limit(limit);
}

export async function countPendingOpsRequests(db: Db): Promise<number> {
  return (await countOpenControlRequests(db, controlRequestKindEnum.enumValues)).pending;
}
