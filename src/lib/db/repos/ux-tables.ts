/** Whether the tables and the column of the "seen" and "closed by me" features exist yet. */
import { sql } from "drizzle-orm";

import type { Executor } from "../executor";

let ready = false;

/**
 * Whether `job_seen`, `job_closure_overrides` and `jobs.link_check_json` exist (one migration adds all three). A web process that
 * serves pages before the runner applied the migration (during an upgrade) must not fail its lists over a missing table (42P01) or
 * column (42703): until then the lists treat every job as seen and use the automatic status alone. Checked with `to_regclass` and
 * the catalog, which never throw; once everything is there the answer is cached for the life of the process.
 */
export async function uxTablesReady(db: Executor): Promise<boolean> {
  if (ready) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`
    select (to_regclass('job_seen') is not null
      and to_regclass('job_closure_overrides') is not null
      and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'jobs' and column_name = 'link_check_json')) as ok`);
  ready = row?.ok === true;
  return ready;
}

/** For tests: forget the cached answer. */
export function resetUxTablesCache(): void {
  ready = false;
}
