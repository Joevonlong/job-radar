/** Reads and writes of `job_seen`, the jobs the user has looked at. C9: every query of the feature lives here. */
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../executor";
import { jobs, jobSeen, jobSeenViaEnum } from "../schema";

export type SeenVia = (typeof jobSeenViaEnum.enumValues)[number];

/** The ways a single job is marked seen from the interface (`bulk` and `migration` are batch writes). */
export const SEEN_VIAS = ["detail", "source", "action"] as const satisfies readonly SeenVia[];

/** SQL: the job of the current row has been seen. */
export function seenSql(): SQL<boolean> {
  // written with the table name: a column interpolated into a subquery can render without its table (see notifications.ts)
  return sql<boolean>`exists (select 1 from ${jobSeen} where ${jobSeen.jobId} = "jobs"."id")`;
}

/** Mark a job seen. Idempotent: the first sighting is kept (`seen_at` and `via` are not touched by a later look). True when it was unseen. */
export async function markSeen(db: Executor, jobId: number, via: SeenVia, at: Date = new Date()): Promise<boolean> {
  const rows = await db.insert(jobSeen).values({ jobId, via, seenAt: at }).onConflictDoNothing().returning({ jobId: jobSeen.jobId });
  return rows.length > 0;
}

/** Mark a job unseen again (bold with a dot in the lists). True when it was seen. */
export async function markUnseen(db: Executor, jobId: number): Promise<boolean> {
  const rows = await db.delete(jobSeen).where(eq(jobSeen.jobId, jobId)).returning({ jobId: jobSeen.jobId });
  return rows.length > 0;
}

/** Whether the job has been seen. */
export async function isSeen(db: Executor, jobId: number): Promise<boolean> {
  const [row] = await db.select({ jobId: jobSeen.jobId }).from(jobSeen).where(eq(jobSeen.jobId, jobId)).limit(1);
  return row !== undefined;
}

/**
 * "Mark all seen" over a set of jobs (/jobs: every job of the filtered list across its pages; Today: the jobs of the view on screen):
 * each one that is still unseen gets a row with `via = 'bulk'` and the one time `at`, the batch's key for the undo. One statement
 * (the ids travel as one array parameter). Returns how many jobs became seen.
 */
export async function markSeenIds(db: Executor, jobIds: readonly number[], at: Date): Promise<number> {
  const ids = [...new Set(jobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return 0;
  const rows = await db.execute<{ job_id: string }>(sql`
    insert into ${jobSeen} (job_id, seen_at, via)
    select j.id, ${at.toISOString()}::timestamptz, 'bulk'
    from unnest(${`{${ids.join(",")}}`}::bigint[]) as picked(id)
    join ${jobs} j on j.id = picked.id
    on conflict do nothing
    returning job_id`);
  return rows.length;
}

/** Undo one "mark all seen": only that batch's rows go (jobs seen before it, or one by one since, stay seen). */
export async function undoBulkSeen(db: Executor, at: Date): Promise<number> {
  const rows = await db
    .delete(jobSeen)
    .where(and(eq(jobSeen.via, "bulk"), eq(jobSeen.seenAt, at)))
    .returning({ jobId: jobSeen.jobId });
  return rows.length;
}
