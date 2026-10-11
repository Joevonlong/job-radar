import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { getLatestHeartbeat } from "./repos/heartbeats";

/** True when the database answers a trivial query. Never throws and never exposes the error. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Latest runner heartbeat time, or null when none exists (or the table is not migrated yet). */
export async function readLatestHeartbeatAt(db: Db): Promise<Date | null> {
  try {
    return (await getLatestHeartbeat(db))?.at ?? null;
  } catch {
    return null;
  }
}
