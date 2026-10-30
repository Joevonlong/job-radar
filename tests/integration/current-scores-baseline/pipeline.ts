// Frozen pre-projection query baseline.
import { asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { listEventsByApplication, type Application, type ApplicationEvent } from "@/lib/db/repos/applications";
import { applications, companies, jobs } from "@/lib/db/schema";
import { uxTablesReady } from "@/lib/db/repos/ux-tables";
import { cardColumns, hydrateCards, latestScoreCte } from "./job-cards";
import type { JobCard } from "@/lib/db/queries/types";
import { listingReady } from "@/lib/db/repos/listing";
import { dormancyReady } from "@/lib/db/repos/dormancy";

/** One card of the pipeline board: the job as the lists show it, its application, and the application's events. */
export interface PipelineEntry {
  job: JobCard;
  application: Application;
  /** Every status change, newest first. */
  events: ApplicationEvent[];
}

/**
 * Every job that has an application, best rank first. A job that the hard filter removed or that closed
 * stays: the user moved it into the pipeline on purpose. Status `new` is a real application row ("no
 * decision yet": a note, an attached resume, or a job set back to `new`), so it is a card in the board's
 * first column, not hidden; jobs without any application row are not on the board.
 */
export async function listPipelineEntries(db: Db, options: { visa?: boolean } = {}): Promise<PipelineEntry[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const rows = await db
    .with(latest)
    .select({ ...cardColumns(latest, ux, await dormancyReady(db), await listingReady(db)), application: applications })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .orderBy(sql`${latest.rankValue} desc nulls last`, desc(applications.statusChangedAt), asc(applications.id));

  const cards = await hydrateCards(db, rows, { visa: options.visa ?? true });
  const events = await listEventsByApplication(
    db,
    rows.map((r) => r.application.id),
  );
  return rows.flatMap((row, index) => {
    const job = cards[index];
    return job ? [{ job, application: row.application, events: events.get(row.application.id) ?? [] }] : [];
  });
}
