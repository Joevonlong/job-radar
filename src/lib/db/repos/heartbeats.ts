import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import type { Db } from "../client";
import { runnerHeartbeats } from "../schema";

export type Heartbeat = typeof runnerHeartbeats.$inferSelect;

export async function writeHeartbeat(db: Db, process: string): Promise<Heartbeat> {
  const [row] = await db.insert(runnerHeartbeats).values({ process }).returning();
  if (!row) throw new Error("writeHeartbeat: insert returned no row");
  return row;
}

/** Process names in `runner_heartbeats.process`. */
export const HEARTBEAT_PROCESS = { runner: "runner", aiWorker: "ai-worker" } as const;

/** Newest heartbeat of one process (default: the container runner, so the ai-worker's beats never make a dead runner look alive). */
export async function getLatestHeartbeat(db: Db, process: string = HEARTBEAT_PROCESS.runner): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(runnerHeartbeats)
    .where(eq(runnerHeartbeats.process, process))
    .orderBy(desc(runnerHeartbeats.at), desc(runnerHeartbeats.id))
    .limit(1);
  return row ?? null;
}

/**
 * Is there a heartbeat of `process` at or after `atLeast`? `atLeast` is a timestamptz literal (e.g. the microsecond UTC
 * text of `dbNow`), compared in SQL so no precision is lost.
 */
export async function hasHeartbeatSince(db: Db, process: string, atLeast: string): Promise<boolean> {
  const rows = await db
    .select({ id: runnerHeartbeats.id })
    .from(runnerHeartbeats)
    .where(and(eq(runnerHeartbeats.process, process), gte(runnerHeartbeats.at, sql`${atLeast}::timestamptz`)))
    .limit(1);
  return rows.length > 0;
}

/** Delete heartbeats older than `cutoff`; returns the number of rows removed. */
export async function pruneHeartbeats(db: Db, cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(runnerHeartbeats)
    .where(lt(runnerHeartbeats.at, cutoff))
    .returning({ id: runnerHeartbeats.id });
  return deleted.length;
}
