import { desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { FavoriteSort } from "@/lib/jobs/constants";
import { companies, jobFavorites, jobs } from "../schema";
import { uxTablesReady } from "../repos/ux-tables";
import { cardColumns, hydrateCards, latestScoreCte, type CardRow } from "./job-cards";
import type { JobCard } from "./types";

/**
 * Every starred job, with no filter at all: closed, possibly closed, hard-filtered and ignored jobs are listed too,
 * the list rows mark them. `starred`: newest star first; `rank`: filtered-out last, then the rank value.
 */
export async function listFavoriteJobs(db: Db, options: { sort: FavoriteSort }): Promise<JobCard[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const orderBy =
    options.sort === "rank"
      ? [sql`coalesce(${latest.filterResult} = 'filtered_out', false) asc`, sql`${latest.rankValue} desc nulls last`, desc(jobFavorites.createdAt), desc(jobs.id)]
      : [desc(jobFavorites.createdAt), desc(jobs.id)];
  const rows: CardRow[] = await db
    .with(latest)
    .select(cardColumns(latest, ux))
    .from(jobFavorites)
    .innerJoin(jobs, eq(jobs.id, jobFavorites.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .orderBy(...orderBy);
  return hydrateCards(db, rows);
}
