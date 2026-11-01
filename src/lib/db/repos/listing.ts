import { sql, type SQL } from "drizzle-orm";

import type { Executor } from "../executor";

let ready = false;

/** All listing columns must exist before reads or writes name them during an upgrade. */
export async function listingReady(db: Executor): Promise<boolean> {
  if (ready) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`
    select count(*) = 3 as ok from information_schema.columns
    where table_schema = current_schema() and table_name = 'jobs'
      and column_name in ('last_listed_at', 'relisted_at', 'relist_count')`);
  ready = row?.ok === true;
  return ready;
}

/** For tests temporarily restoring the previous schema. */
export function resetListingCache(): void {
  ready = false;
}

/** The new value of each listing column; expressions use the locked UPDATE target (jobs), never an earlier snapshot of its baseline. */
export function listingColumnsSql(observed: SQL, observedCycle: SQL, minGapDays: number): { relistedAt: SQL; relistCount: SQL; lastListedAt: SQL } {
  const gap = sql`${minGapDays} > 0 and jobs.last_listed_at is not null
    and ${observed} >= jobs.last_listed_at + ${minGapDays} * interval '1 day'
    and exists (select 1 from job_sources listing_source
      join runs listing_run on listing_run.channel_id = listing_source.channel_id
      where listing_source.job_id = jobs.id and listing_run.status = 'succeeded'
        and listing_run.window_extended = false and listing_run.cycle_id is not null
        and listing_run.cycle_id is distinct from ${observedCycle}
        and listing_run.started_at > jobs.last_listed_at and listing_run.finished_at < ${observed})`;
  return {
    relistedAt: sql`case when ${gap} then ${observed} else jobs.relisted_at end`,
    relistCount: sql`coalesce(jobs.relist_count, 0) + case when ${gap} then 1 else 0 end`,
    lastListedAt: sql`greatest(coalesce(jobs.last_listed_at, ${observed}), ${observed})`,
  };
}

/** The same expressions as a SET fragment (raw SQL updates). */
export function listingSetSql(observed: SQL, observedCycle: SQL, minGapDays: number): SQL {
  const columns = listingColumnsSql(observed, observedCycle, minGapDays);
  return sql`relisted_at = ${columns.relistedAt}, relist_count = ${columns.relistCount}, last_listed_at = ${columns.lastListedAt}`;
}

/** Record one listing atomically; repeated and out-of-order observations cannot count again. */
export async function recordJobListing(tx: Executor, input: { jobId: number; observedAt: Date; observedRunId: number | null; minGapDays: number }): Promise<boolean> {
  if (!(await listingReady(tx))) return false;
  const observed = sql`${input.observedAt.toISOString()}::timestamptz`;
  const cycle = sql`(select cycle_id from runs where id = ${input.observedRunId})`;
  const [row] = await tx.execute<{ relisted: boolean }>(sql`
    update jobs set ${listingSetSql(observed, cycle, input.minGapDays)}
    where id = ${input.jobId} and (last_listed_at is null or last_listed_at < ${observed})
    returning coalesce(relisted_at = ${observed}, false) as relisted`);
  return row?.relisted === true;
}
