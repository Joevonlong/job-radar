/**
 * The status a job shows, in SQL (the same rule as `effectiveJobStatus` / `closedReason` in `lib/jobs/closure.ts`): the
 * automatic status of `jobs.status` with the user's judgement of `job_closure_overrides` on top. `ux` = the tables exist
 * (`uxTablesReady`); before the migration the automatic status alone.
 */
import { sql, type SQL } from "drizzle-orm";

import type { ClosedReason } from "@/lib/jobs/closure";

import { jobClosureOverrides, jobs } from "../schema";
import type { JobStatus } from "./types";

// written with the table name: a column interpolated into a subquery can render without its table (see notifications.ts)
function overrideAction(): SQL<string | null> {
  return sql<string | null>`(select ${jobClosureOverrides.action}::text from ${jobClosureOverrides} where ${jobClosureOverrides.jobId} = "jobs"."id")`;
}

/** `closed` / `active` by the user's judgement, else `jobs.status`. */
export function effectiveStatusSql(ux: boolean): SQL<JobStatus> {
  if (!ux) return sql<JobStatus>`${jobs.status}::text`;
  return sql<JobStatus>`(case ${overrideAction()} when 'closed' then 'closed' when 'open' then 'active' else ${jobs.status}::text end)`;
}

/** Why it shows as (possibly) closed: manual / gone / phrase / possibly; null when open. */
export function closedReasonSql(ux: boolean): SQL<ClosedReason | null> {
  if (!ux) return sql<ClosedReason | null>`(case ${jobs.status} when 'closed' then 'gone' when 'possibly_closed' then 'possibly' end)`;
  return sql<ClosedReason | null>`(case ${overrideAction()}
    when 'closed' then 'manual'
    when 'open' then null
    else (case ${jobs.status}
      when 'closed' then 'gone'
      when 'possibly_closed' then (case when ${jobs.linkCheckJson}->>'outcome' = 'phrase' then 'phrase' else 'possibly' end)
    end) end)`;
}

/** The job is closed by the user. */
export function manuallyClosedSql(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${jobClosureOverrides} where ${jobClosureOverrides.jobId} = "jobs"."id" and ${jobClosureOverrides.action} = 'closed')`;
}

/**
 * The job shows as active (the same answer as `effectiveStatusSql(ux) = 'active'`): automatically active and not closed by the user,
 * or kept open by the user ("Still open") whatever the checks said. The score queue and the notifications take these jobs. The OR
 * with a correlated EXISTS means Postgres scans `jobs` rather than using an index on `status`; both callers already narrow the rows
 * by other conditions (score state, first-seen window), and `job_closure_overrides` is keyed by `job_id`.
 */
export function effectivelyActiveSql(ux: boolean): SQL<boolean> {
  if (!ux) return sql<boolean>`${jobs.status} = 'active'`;
  return sql<boolean>`((${jobs.status} = 'active' and not ${manuallyClosedSql()})
    or exists (select 1 from ${jobClosureOverrides} where ${jobClosureOverrides.jobId} = "jobs"."id" and ${jobClosureOverrides.action} = 'open'))`;
}
