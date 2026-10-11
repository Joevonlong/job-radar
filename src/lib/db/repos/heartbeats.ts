import { desc, eq, lt } from "drizzle-orm";

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

/** Delete heartbeats older than `cutoff`; returns the number of rows removed. */
export async function pruneHeartbeats(db: Db, cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(runnerHeartbeats)
    .where(lt(runnerHeartbeats.at, cutoff))
    .returning({ id: runnerHeartbeats.id });
  return deleted.length;
}
