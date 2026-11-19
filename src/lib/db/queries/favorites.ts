import { desc, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import type { FavoriteSort } from "@/lib/jobs/constants";
import { companies, jobFavorites, jobs } from "../schema";
import { uxTablesReady } from "../repos/ux-tables";
import { withCurrentScore, currentScoreRead, cardColumns, hydrateCards, currentScore, type CardRow } from "./job-cards";
import type { JobCard } from "./types";
import { listingReady } from "../repos/listing";
import { dormancyReady } from "../repos/dormancy";

/**
 * Every starred job, with no filter at all: closed, possibly closed, hard-filtered and ignored jobs are listed too,
 * the list rows mark them. `starred`: newest star first; `rank`: filtered-out last, then the rank value.
 */
export async function listFavoriteJobs(db: Executor, options: { sort: FavoriteSort; visa?: boolean; ghost?: boolean; jobIds?: readonly number[] }): Promise<JobCard[]> {
  if (options.jobIds?.length === 0) return [];
  return currentScoreRead(db, async () => {
    const latest = await currentScore(db, "set");
    const ux = await uxTablesReady(db);
    const orderBy =
      options.sort === "rank"
        ? [sql`coalesce(${latest.filterResult} = 'filtered_out', false) asc`, sql`${latest.rankValue} desc nulls last`, desc(jobFavorites.createdAt), desc(jobs.id)]
        : [desc(jobFavorites.createdAt), desc(jobs.id)];
    const rows: CardRow[] = await withCurrentScore(db, latest)
      .select(cardColumns(latest, ux, await dormancyReady(db), await listingReady(db)))
      .from(jobFavorites)
      .innerJoin(jobs, eq(jobs.id, jobFavorites.jobId))
      .innerJoin(companies, eq(companies.id, jobs.companyId))
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(options.jobIds === undefined ? undefined : inArray(jobs.id, [...options.jobIds]))
      .orderBy(...orderBy);
    return hydrateCards(db, rows, { visa: options.visa ?? true, ghost: options.ghost === true });
  });
}
