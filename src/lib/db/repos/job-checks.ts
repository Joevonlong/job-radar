/** Whether the tables of the job checks exist (the visa check's `job_visa`). C9: the probe lives here. */
import { sql } from "drizzle-orm";

import type { Executor } from "../executor";

/** A table of a job check. */
export type JobCheckTable = "job_visa";

const seen = new Set<JobCheckTable>();

/**
 * Whether a job check's table exists. A process that started before the migration ran (the runner or the ai-worker during a
 * deploy) must not fail because of a missing table (42P01): readers treat every job as not checked yet, writers skip. Checked with
 * `to_regclass`, which never throws, so this is safe inside a transaction; once the table is there the answer is cached.
 */
export async function checkTableReady(db: Executor, table: JobCheckTable): Promise<boolean> {
  if (seen.has(table)) return true;
  const [row] = await db.execute<{ name: string | null }>(sql`select to_regclass(${table})::text as name`);
  const ready = row?.name !== null && row?.name !== undefined;
  if (ready) seen.add(table);
  return ready;
}

/** For tests: forget which tables were seen. */
export function resetCheckTablesCache(): void {
  seen.clear();
}
