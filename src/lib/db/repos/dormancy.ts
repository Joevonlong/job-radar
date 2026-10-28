import { eq, getTableColumns, sql, type SQL } from "drizzle-orm";

import { PIPELINE_STATUSES } from "@/lib/dashboard/board";

import type { Executor } from "../executor";
import { jobs } from "../schema";

let ready = false;

/** Until both nullable columns exist, reads and writes keep working with the previous schema. */
export async function dormancyReady(db: Executor): Promise<boolean> {
  if (ready) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`
    select count(*) = 2 as ok from information_schema.columns
    where table_schema = current_schema() and table_name = 'jobs'
      and column_name in ('dormant_at', 'possibly_closed_at')`);
  ready = row?.ok === true;
  return ready;
}

/** For tests that temporarily restore the previous schema. */
export function resetDormancyCache(): void {
  ready = false;
}

/** Full job reads also work for CLI callers during the migration window. */
export async function jobReadColumns(db: Executor) {
  const { dormantAt, possiblyClosedAt, searchTsv, descriptionMd5, descriptionHasText, salaryMd5, ...columns } = getTableColumns(jobs);
  // Derived storage columns are internal to queries, not part of the domain job transferred to callers.
  void [searchTsv, descriptionMd5, descriptionHasText, salaryMd5];
  const available = await dormancyReady(db);
  return { ...columns, dormantAt: available ? dormantAt : sql<Date | null>`null`, possiblyClosedAt: available ? possiblyClosedAt : sql<Date | null>`null` };
}

export interface DormancyOptions {
  now: Date;
  possiblyClosedAfterDays: number;
  dormantAfterDays: number;
}

function protectedSql(): SQL<boolean> {
  return sql<boolean>`(exists (select 1 from job_closure_overrides where job_id = jobs.id)
    or exists (select 1 from job_favorites where job_id = jobs.id)
    or exists (select 1 from applications where job_id = jobs.id and status in (
      ${sql.join(PIPELINE_STATUSES.map((status) => sql`${status}`), sql`, `)})))`;
}

function overdueSql(input: DormancyOptions): SQL<boolean> {
  return sql<boolean>`greatest(jobs.possibly_closed_at, jobs.last_seen_at + make_interval(days => ${input.possiblyClosedAfterDays}))
    < ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.dormantAfterDays})`;
}

/** Mark only old possibly-closed jobs without user protection; never remove their data. */
export async function markJobsDormant(db: Executor, input: DormancyOptions): Promise<number> {
  if (input.dormantAfterDays === 0 || !(await dormancyReady(db))) return 0;
  const result = await db.execute(sql`
    update jobs set dormant_at = ${input.now.toISOString()}::timestamptz
    where status = 'possibly_closed' and dormant_at is null
      and ${overdueSql(input)} and not ${protectedSql()}`);
  return result.count;
}

/** A separate statement after marking sees protection committed while the mark was running. */
export async function wakeIneligibleDormantJobs(db: Executor, input: DormancyOptions): Promise<number> {
  if (!(await dormancyReady(db))) return 0;
  const ineligible = input.dormantAfterDays === 0 ? sql`true` : sql`
    status <> 'possibly_closed' or dormant_at <= last_seen_at or ${protectedSql()} or not (${overdueSql(input)})`;
  const result = await db.execute(sql`update jobs set dormant_at = null where dormant_at is not null and (${ineligible})`);
  return result.count;
}

/** Always take the job's row lock, even if a concurrent marker has not set dormant_at yet. */
export async function wakeDormantJob(tx: Executor, jobId: number): Promise<void> {
  if (!(await dormancyReady(tx))) return;
  await tx.update(jobs).set({ dormantAt: null }).where(eq(jobs.id, jobId));
}
