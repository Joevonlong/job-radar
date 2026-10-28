import { and, asc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { companies, jobFilterOverrides, jobs, scores } from "../schema";
import { notDormantSql } from "../queries/job-status";
import { dormancyReady } from "./dormancy";
import { changeFingerprintsReady } from "./change-fingerprints";

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
  /** `companies.watched`: the user watches the company (the watch list of interests.yaml is read separately). */
  companyWatched: boolean;
  /** `jobs.german_level_required` (the pipeline's rule reading; what a language gate reads). */
  germanLevel: string;
  /** Fingerprint of the exact job/company/override inputs read with this candidate. */
  inputHash?: string;
  /** Read in the same SELECT as inputHash; later override edits are picked up next cycle. */
  filterOverride?: "keep" | "exclude" | null;
}

// Existing rows can remain unfilled after the metadata-only migration. NULL means compute, never unchanged.
function candidateInputHash(ready: boolean) {
  const description = ready ? sql`coalesce(${jobs.descriptionMd5}, md5(coalesce(${jobs.description}, '')))` : sql`md5(coalesce(${jobs.description}, ''))`;
  const salary = ready ? sql`coalesce(${jobs.salaryMd5}, md5(coalesce(${jobs.salaryJson}::text, '')))` : sql`md5(coalesce(${jobs.salaryJson}::text, ''))`;
  return sql<string>`md5(jsonb_build_array(${jobs.title}, ${description}, ${jobs.description} is null, ${jobs.workplace},
    ${jobs.seniority}, ${jobs.contract}, ${jobs.locationsJson}, ${salary}, ${jobs.germanLevelRequired},
    ${companies.name}, ${companies.nameNorm}, ${companies.aliases}, ${companies.blacklisted}, ${companies.watched},
    ${jobFilterOverrides.action})::text)`;
}

/** Jobs that are not closed, by id, after `afterId` (keyset paging: the table can change between batches); `jobIds` limits it to those jobs. */
export async function listFilterCandidates(db: Executor, input: { afterId: number; limit: number; jobIds?: readonly number[]; snapshotId?: number; configHash?: string }): Promise<FilterCandidate[]> {
  const ready = await changeFingerprintsReady(db);
  const inputHash = candidateInputHash(ready);
  const changed = ready && input.snapshotId !== undefined && input.configHash !== undefined && !input.jobIds
    ? sql`not exists (select 1 from scores sc where sc.job_id = ${jobs.id} and sc.profile_snapshot_id = ${input.snapshotId}
        and sc.filter_config_hash = ${input.configHash} and sc.filter_input_hash = ${inputHash})`
    : undefined;
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
      companyWatched: companies.watched,
      germanLevel: jobs.germanLevelRequired,
      inputHash,
      filterOverride: jobFilterOverrides.action,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(jobFilterOverrides, eq(jobFilterOverrides.jobId, jobs.id))
    .where(and(gt(jobs.id, input.afterId), ne(jobs.status, "closed"), input.jobIds ? inArray(jobs.id, [...input.jobIds]) : notDormantSql(await dormancyReady(db)), changed))
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
  filterInputHash?: string | null;
  filterConfigHash?: string | null;
}

/**
 * Store the filter result of jobs that have none under this snapshot. One row per (job, snapshot):
 * the partial unique index makes a repeated insert a no-op. Returns the number of rows written.
 */
export async function insertFilterResults(db: Executor, snapshotId: number, rows: readonly NewFilterResult[]): Promise<number> {
  if (rows.length === 0) return 0;
  if (!(await changeFingerprintsReady(db))) {
    // A regular Drizzle INSERT lists all nullable columns as DEFAULT, including the not-yet-added hashes.
    const values = rows.map((row) => sql`(${row.jobId}, ${snapshotId}, ${row.filterResult}::filter_result, ${sql.param(row.filterReasons, scores.filterReasons)})`);
    const written = await db.execute(sql`insert into scores (job_id, profile_snapshot_id, filter_result, filter_reasons)
      values ${sql.join(values, sql`, `)} on conflict (job_id, profile_snapshot_id) where profile_snapshot_id is not null
      do nothing returning id`);
    return written.count;
  }
  const written = await db
    .insert(scores)
    .values(rows.map((r) => ({ ...r, profileSnapshotId: snapshotId })))
    .onConflictDoNothing({ target: [scores.jobId, scores.profileSnapshotId], where: isNotNull(scores.profileSnapshotId) })
    .returning({ id: scores.id });
  return written.length;
}

/** Replace the filter result of an existing row (the job changed). The AI fields of the row are left alone. */
export async function updateFilterResult(db: Executor, scoreId: number, result: Omit<NewFilterResult, "jobId">): Promise<void> {
  const values = await changeFingerprintsReady(db) ? result : { filterResult: result.filterResult, filterReasons: result.filterReasons };
  await db.update(scores).set(values).where(eq(scores.id, scoreId));
}
