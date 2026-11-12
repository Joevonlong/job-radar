import { sql } from "drizzle-orm";

import type { Executor } from "../executor";

/** Serialize missing-application snapshots and creation without holding a parent row lock during the child insert. */
export async function lockApplicationCreation(db: Executor, jobId: number): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended('application_creation:' || ${jobId}::text, 0))`);
}
