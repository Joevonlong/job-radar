// Frozen pre-projection query baseline.
import { sql } from "drizzle-orm";

import { PIPELINE_STATUSES } from "@/lib/dashboard/board";

import type { Db } from "@/lib/db/client";
import { dormancyReady } from "@/lib/db/repos/dormancy";
import { uxTablesReady } from "@/lib/db/repos/ux-tables";
import { effectivelyNotClosedSql, notDormantSql } from "@/lib/db/queries/job-status";

/** The numbers behind the nav badges (sidebar and phone drawer). */
export interface NavCounts {
  /** Jobs first seen today (calendar day in the schedule's time zone) that the Today list shows: not filtered out, not ignored. */
  today: number;
  /** Jobs the /jobs list shows without any filter: not filtered out, effectively closed or dormant. */
  jobs: number;
  /** Applications in the pipeline: not ended, `new` included (the one definition is `PIPELINE_STATUSES` in `lib/dashboard/board`, shared with the board). */
  pipeline: number;
  /** Starred jobs, closed ones included. */
  favorites: number;
  /** Enabled channels that need a look: an open circuit or health `down`. A warning, not a total. */
  sourcesAlert: number;
}

/**
 * One round trip for all nav badges. "Filtered out" reads the newest `scores` row per job (the same rule as the lists'
 * `latest_score`: the filter result always comes from the newest row).
 */
export async function getNavCounts(db: Db, options: { now: Date; timezone: string }): Promise<NavCounts> {
  const [ux, dormant] = await Promise.all([uxTablesReady(db), dormancyReady(db)]);
  const rows = await db.execute<{ today: number; jobs: number; pipeline: number; favorites: number; sources_alert: number }>(sql`
    with newest as (
      select distinct on (job_id) job_id, filter_result
      from scores
      order by job_id, created_at desc, id desc
    ),
    day as (
      select (date_trunc('day', ${options.now.toISOString()}::timestamptz at time zone ${options.timezone}) at time zone ${options.timezone}) as start_at
    ),
    listed as (
      select j.id, j.first_seen_at,
             exists (select 1 from applications a where a.job_id = j.id and a.status = 'archived') as ignored
      from jobs j
      left join newest n on n.job_id = j.id
      where (n.filter_result is null or n.filter_result <> 'filtered_out')
        and ${effectivelyNotClosedSql(ux, "j")} and ${notDormantSql(dormant, "j")}
    )
    select
      (select count(*) from listed, day where not listed.ignored and listed.first_seen_at >= day.start_at and listed.first_seen_at < day.start_at + interval '1 day')::int as today,
      (select count(*) from listed)::int as jobs,
      (select count(*) from applications where status in (${sql.join(PIPELINE_STATUSES.map((status) => sql`${status}`), sql`, `)}))::int as pipeline,
      (select count(*) from job_favorites)::int as favorites,
      (select count(*) from channels where enabled and (circuit_state = 'open' or health = 'down'))::int as sources_alert
  `);
  const row = rows[0];
  return { today: row?.today ?? 0, jobs: row?.jobs ?? 0, pipeline: row?.pipeline ?? 0, favorites: row?.favorites ?? 0, sourcesAlert: row?.sources_alert ?? 0 };
}
