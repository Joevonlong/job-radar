import { and, asc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";

import type { Executor } from "../executor";
import { companies, jobs, scores } from "../schema";

/** A job with what the hard filter reads of it. */
export interface FilterCandidate {
  id: number;
  title: string;
  description: string | null;
  workplace: "onsite" | "hybrid" | "remote" | "unknown";
  seniority: string;
  contract: string;
  locationsJson: unknown;
  salaryJson: unknown;
  companyName: string;
  companyNameNorm: string | null;
  companyAliases: string[];
  companyBlacklisted: boolean;
  /** `jobs.german_level_required` (the pipeline's rule reading; what a language gate reads). */
  germanLevel: string;
}

/** Jobs that are not closed, by id, after `afterId` (keyset paging: the table can change between batches); `jobIds` limits it to those jobs. */
export async function listFilterCandidates(db: Executor, input: { afterId: number; limit: number; jobIds?: readonly number[] }): Promise<FilterCandidate[]> {
  return db
    .select({
      id: jobs.id,
      title: jobs.title,
      description: jobs.description,
      workplace: jobs.workplace,
      seniority: jobs.seniority,
      contract: jobs.contract,
      locationsJson: jobs.locationsJson,
      salaryJson: jobs.salaryJson,
      companyName: companies.name,
      companyNameNorm: companies.nameNorm,
      companyAliases: companies.aliases,
      companyBlacklisted: companies.blacklisted,
      germanLevel: jobs.germanLevelRequired,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(gt(jobs.id, input.afterId), ne(jobs.status, "closed"), input.jobIds ? inArray(jobs.id, [...input.jobIds]) : undefined))
    .orderBy(asc(jobs.id))
    .limit(input.limit);
}

export interface StoredFilterResult {
  scoreId: number;
  jobId: number;
  filterResult: "passed" | "filtered_out";
  filterReasons: string[];
}

/** The filter result already stored for these jobs under this profile snapshot. */
export async function getFilterResults(db: Executor, snapshotId: number, jobIds: readonly number[]): Promise<Map<number, StoredFilterResult>> {
  const out = new Map<number, StoredFilterResult>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({ scoreId: scores.id, jobId: scores.jobId, filterResult: scores.filterResult, filterReasons: scores.filterReasons })
    .from(scores)
    .where(and(eq(scores.profileSnapshotId, snapshotId), inArray(scores.jobId, [...jobIds])));
  for (const row of rows) out.set(row.jobId, row);
  return out;
}

export interface NewFilterResult {
  jobId: number;
  filterResult: "passed" | "filtered_out";
  filterReasons: string[];
}

/**
 * Store the filter result of jobs that have none under this snapshot. One row per (job, snapshot):
 * the partial unique index makes a repeated insert a no-op. Returns the number of rows written.
 */
export async function insertFilterResults(db: Executor, snapshotId: number, rows: readonly NewFilterResult[]): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await db
    .insert(scores)
    .values(rows.map((r) => ({ jobId: r.jobId, profileSnapshotId: snapshotId, filterResult: r.filterResult, filterReasons: r.filterReasons })))
    .onConflictDoNothing({ target: [scores.jobId, scores.profileSnapshotId], where: isNotNull(scores.profileSnapshotId) })
    .returning({ id: scores.id });
  return written.length;
}

/** Replace the filter result of an existing row (the job changed). The AI fields of the row are left alone. */
export async function updateFilterResult(db: Executor, scoreId: number, result: Pick<NewFilterResult, "filterResult" | "filterReasons">): Promise<void> {
  await db.update(scores).set({ filterResult: result.filterResult, filterReasons: result.filterReasons }).where(eq(scores.id, scoreId));
}
