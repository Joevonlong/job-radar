/**
 * The status a job shows, in SQL (the same rule as `effectiveJobStatus` / `closedReason` in `lib/jobs/closure.ts`): the
 * automatic status of `jobs.status` with the user's judgement of `job_closure_overrides` on top. `ux` = the tables exist
 * (`uxTablesReady`); before the migration the automatic status alone.
 */
import { sql, type SQL } from "drizzle-orm";

import type { ClosedReason } from "@/lib/jobs/closure";
import type { ArchiveReason, JobScope } from "@/lib/jobs/constants";

import { jobClosureOverrides, jobSources, jobs, rawPostings } from "../schema";
import type { JobStatus } from "./types";

// written with the table name: a column interpolated into a subquery can render without its table (see notifications.ts)
function jobColumn(name: string, alias = "jobs"): SQL {
  return sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
}

function overrideAction(alias?: string): SQL<string | null> {
  return sql<string | null>`(select ${jobClosureOverrides.action}::text from ${jobClosureOverrides} where ${jobClosureOverrides.jobId} = ${jobColumn("id", alias)})`;
}

/** `closed` / `active` by the user's judgement, else `jobs.status`. */
export function effectiveStatusSql(ux: boolean, alias?: string): SQL<JobStatus> {
  const status = jobColumn("status", alias);
  if (!ux) return sql<JobStatus>`${status}::text`;
  return sql<JobStatus>`(case ${overrideAction(alias)} when 'closed' then 'closed' when 'open' then 'active' else ${status}::text end)`;
}

/** Same as effectiveStatusSql <> closed; EXISTS lets Postgres hash the override ids for aggregate counts. */
export function effectivelyNotClosedSql(ux: boolean, alias?: string): SQL<boolean> {
  const automatic = sql<boolean>`${jobColumn("status", alias)} <> 'closed'`;
  if (!ux) return automatic;
  const override = (action: "open" | "closed") => sql`exists (select 1 from ${jobClosureOverrides}
    where ${jobClosureOverrides.jobId} = ${jobColumn("id", alias)} and ${jobClosureOverrides.action} = ${action})`;
  return sql<boolean>`((${automatic} and not ${override("closed")}) or ${override("open")})`;
}

function overrideIdsSql(action?: "open" | "closed"): SQL {
  return sql`(select ${jobClosureOverrides.jobId} from ${jobClosureOverrides}${action === undefined ? sql`` : sql` where ${jobClosureOverrides.action} = ${action}`})`;
}

/** Same predicate as effectivelyNotClosedSql; override job ids are non-null primary keys, so NOT IN is safe. */
function effectivelyNotClosedInSql(ux: boolean, alias?: string): SQL<boolean> {
  const automatic = sql<boolean>`${jobColumn("status", alias)} <> 'closed'`;
  if (!ux) return automatic;
  const id = jobColumn("id", alias);
  return sql<boolean>`((${automatic} and ${id} not in ${overrideIdsSql("closed")}) or ${id} in ${overrideIdsSql("open")})`;
}

/** Stored dormancy remains meaningful only until another sighting or a change of automatic status. */
export function dormantSql(ready: boolean, alias?: string): SQL<boolean> {
  if (!ready) return sql<boolean>`false`;
  return sql<boolean>`(${jobColumn("status", alias)} = 'possibly_closed'
    and ${jobColumn("dormant_at", alias)} is not null
    and ${jobColumn("dormant_at", alias)} > ${jobColumn("last_seen_at", alias)})`;
}

export function notDormantSql(ready: boolean, alias?: string): SQL<boolean> {
  return ready ? sql<boolean>`not ${dormantSql(ready, alias)}` : sql<boolean>`true`;
}

/**
 * Current is exactly the legacy list's two hiding conditions; archive is its complement; all adds no condition.
 * Uncorrelated IN uses hashed subplans with small cost estimates, keeping the list below JIT inline/optimize thresholds.
 */
export function jobScopeSql(scope: JobScope, ux: boolean, dormantReady: boolean, alias?: string): SQL<boolean> | undefined {
  if (scope === "all") return undefined;
  if (scope === "archive") return sql<boolean>`(not ${effectivelyNotClosedInSql(ux, alias)} or ${dormantSql(dormantReady, alias)})`;
  return sql<boolean>`(${effectivelyNotClosedInSql(ux, alias)} and ${notDormantSql(dormantReady, alias)})`;
}

/**
 * Same rows as closedReasonSql IN reasons. Uncorrelated IN / NOT IN uses hashed subplans with small cost estimates,
 * keeping the list below JIT inline/optimize thresholds even when predicates are combined with OR.
 */
export function archiveReasonSql(reasons: readonly ArchiveReason[], ux: boolean, dormantReady: boolean, alias?: string): SQL<boolean> | undefined {
  if (reasons.length === 0) return undefined;
  const noOverride = ux ? sql`${jobColumn("id", alias)} not in ${overrideIdsSql()}` : sql`true`;
  const predicates = reasons.map((reason) => {
    switch (reason) {
      case "manual":
        return ux ? sql`${jobColumn("id", alias)} in ${overrideIdsSql("closed")}` : sql`false`;
      case "gone":
        return sql`(${jobColumn("status", alias)} = 'closed' and ${noOverride})`;
      case "dormant":
        return sql`(${dormantSql(dormantReady, alias)} and ${noOverride})`;
    }
  });
  return sql<boolean>`(${sql.join(predicates, sql` or `)})`;
}

/**
 * Newest fetch of a source posting, never the link-check-updated last_seen_at; no source means null.
 * A later migration can read a stored last_listed_at with this subquery as fallback when the column is unavailable or null.
 * Qualify every column explicitly so a single-table selection and an aliased outer job remain safe.
 */
export function lastListedSql(alias?: string): SQL<Date | null> {
  return sql<Date | null>`(select max(${jobColumn(rawPostings.fetchedAt.name, "r")})
    from ${jobSources} js join ${rawPostings} r on ${jobColumn(rawPostings.id.name, "r")} = ${jobColumn(jobSources.rawPostingId.name, "js")}
    where ${jobColumn(jobSources.jobId.name, "js")} = ${jobColumn("id", alias)})`.mapWith(rawPostings.fetchedAt);
}

/** The same priority as closedReason: manual, gone, dormant, phrase, possibly. */
export function closedReasonSql(ux: boolean, dormant = false, alias?: string): SQL<ClosedReason | null> {
  const automatic = sql`(case ${jobColumn("status", alias)}
    when 'closed' then 'gone'
    when 'possibly_closed' then (case when ${dormantSql(dormant, alias)} then 'dormant'
      ${ux ? sql`when ${jobColumn("link_check_json", alias)}->>'outcome' = 'phrase' then 'phrase'` : sql``}
      else 'possibly' end) end)`;
  if (!ux) return sql<ClosedReason | null>`${automatic}`;
  return sql<ClosedReason | null>`(case ${overrideAction(alias)}
    when 'closed' then 'manual'
    when 'open' then null
    else ${automatic} end)`;
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
