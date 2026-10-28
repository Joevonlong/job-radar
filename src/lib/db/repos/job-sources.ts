import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { jobSources, jobs, rawPostings } from "../schema";
import { rawPostingColumns, type RawPosting } from "./raw-postings";

export type JobSource = typeof jobSources.$inferSelect;

export async function getJobSourceByRawPosting(db: Executor, rawPostingId: number): Promise<JobSource | null> {
  const [row] = await db.select().from(jobSources).where(eq(jobSources.rawPostingId, rawPostingId)).orderBy(asc(jobSources.id)).limit(1);
  return row ?? null;
}

export interface JobSourceInput {
  jobId: number;
  rawPostingId: number;
  channelId: string;
  url: string | null;
  applyUrl: string | null;
  locationLabel: string | null;
  priority: number;
  firstSeenAt: Date;
}

/** One row per (job, raw posting); a re-parsed posting refreshes its links and priority. */
export async function upsertJobSource(db: Executor, input: JobSourceInput): Promise<void> {
  await db
    .insert(jobSources)
    .values(input)
    .onConflictDoUpdate({
      target: [jobSources.jobId, jobSources.rawPostingId],
      set: { url: input.url, applyUrl: input.applyUrl, locationLabel: input.locationLabel, priority: input.priority, channelId: input.channelId },
    });
}

/** All sources of a job, best apply-link priority first. */
export async function listJobSources(db: Executor, jobId: number): Promise<JobSource[]> {
  return db.select().from(jobSources).where(eq(jobSources.jobId, jobId)).orderBy(asc(jobSources.priority), asc(jobSources.id));
}

/** Best (lowest) priority among the job's sources other than `rawPostingId`; null when there is none. */
export async function bestOtherPriority(db: Executor, jobId: number, rawPostingId: number): Promise<number | null> {
  const [row] = await db
    .select({ best: sql<number | null>`min(${jobSources.priority})` })
    .from(jobSources)
    .where(and(eq(jobSources.jobId, jobId), ne(jobSources.rawPostingId, rawPostingId)));
  return row?.best ?? null;
}

export interface JobWithRawPostings {
  jobId: number;
  companyId: number;
  title: string;
  titleNorm: string;
  salaryJson: unknown;
  /** Linked raw postings, with the apply-link priority of each; parsed only unless `includeUnparsed` is set. */
  sources: Array<{ priority: number; raw: RawPosting }>;
}

/** The next `limit` jobs with an id above `afterId`, with parsed postings by default or every linked posting for a repair. */
export async function listJobsWithRawPostings(db: Executor, input: { afterId: number; limit: number; includeUnparsed?: boolean }): Promise<JobWithRawPostings[]> {
  const jobRows = await db
    .select({ id: jobs.id, companyId: jobs.companyId, title: jobs.title, titleNorm: jobs.titleNorm, salaryJson: jobs.salaryJson })
    .from(jobs)
    .where(gt(jobs.id, input.afterId))
    .orderBy(asc(jobs.id))
    .limit(input.limit);
  if (jobRows.length === 0) return [];
  const sourceRows = await db
    .select({ jobId: jobSources.jobId, priority: jobSources.priority, raw: rawPostingColumns() })
    .from(jobSources)
    .innerJoin(rawPostings, eq(rawPostings.id, jobSources.rawPostingId))
    .where(and(inArray(jobSources.jobId, jobRows.map((j) => j.id)), input.includeUnparsed ? undefined : eq(rawPostings.parseStatus, "parsed")))
    .orderBy(asc(jobSources.priority), asc(rawPostings.id));
  return jobRows.map((job) => ({
    jobId: job.id,
    companyId: job.companyId,
    title: job.title,
    titleNorm: job.titleNorm,
    salaryJson: job.salaryJson,
    sources: sourceRows.filter((s) => s.jobId === job.id).map(({ priority, raw }) => ({ priority, raw })),
  }));
}

/** Detach these raw postings from the job (the job and the postings stay). Returns the number of rows removed. */
export async function unlinkJobSources(db: Executor, jobId: number, rawPostingIds: readonly number[]): Promise<number> {
  if (rawPostingIds.length === 0) return 0;
  const rows = await db
    .delete(jobSources)
    .where(and(eq(jobSources.jobId, jobId), inArray(jobSources.rawPostingId, [...rawPostingIds])))
    .returning({ id: jobSources.id });
  return rows.length;
}
