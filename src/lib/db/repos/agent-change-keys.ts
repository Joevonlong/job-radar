import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { FamilyMatcher } from "@/lib/salary/families";
import { salaryGroupCandidates } from "@/lib/salary/groups";
import { salaryLookupCompanyMatches, salaryLookupKey } from "@/lib/salary/lookup-key";

import type { Executor } from "../executor";
import { companies, jobs, jobSources } from "../schema";
import { compareSyncEntityKeys, type SyncEntityKey } from "../sync-position";
import type { SyncEntityKind } from "../sync-sources";
import type { AgentChangeRow } from "./agent-changes";
import { firstSalaryLocation, type JobForSalaryLookup } from "./salary-lookups";

export async function listSyncJobIds(db: Executor, after: number, limit: number, filter?: SQL): Promise<number[]> {
  const rows = await db.select({ id: jobs.id }).from(jobs)
    .where(and(gt(jobs.id, after), filter)).orderBy(asc(jobs.id)).limit(limit);
  return rows.map(({ id }) => id);
}

const groupKey = z.tuple([z.string(), z.string(), z.enum(["city", "country", "all"]), z.string(), z.string()]);
export type SyncBenchmarkKey = z.infer<typeof groupKey>;

function parseBenchmarkKey(key: string): SyncBenchmarkKey | null {
  const parsed = groupKey.safeParse(JSON.parse(key));
  return parsed.success ? parsed.data : null;
}

type SalaryCandidate = Pick<JobForSalaryLookup, "title" | "seniority" | "location">;

export function matchesSyncSalaryLookup(job: SalaryCandidate & Pick<JobForSalaryLookup, "companyNorm" | "titleNorm">, key: string, families: FamilyMatcher): boolean {
  return salaryLookupKey(job, families.familyOf(job.title)) === key;
}

export function matchesSyncSalaryBenchmark(job: SalaryCandidate, key: SyncBenchmarkKey, families: FamilyMatcher): boolean {
  const [family, seniority, geoLevel, geoKey] = key;
  return families.familyOf(job.title) === family && salaryGroupCandidates({
    seniority: job.seniority, city: job.location?.city ?? null, country: job.location?.countryCode ?? null,
  }).some((candidate) => candidate.seniority === seniority && candidate.geoLevel === geoLevel && candidate.geoKey === geoKey);
}

async function* jobIdPages(after: number, chunk: number, read: (after: number) => Promise<number[]>) {
  for (;;) {
    const ids = await read(after);
    yield* ids;
    if (ids.length < chunk) return;
    after = ids[ids.length - 1]!;
  }
}

/** Resolve shared keys against the current snapshot. Jobs in the archive have the same dependencies as other jobs. */
export function expandAgentChangeKeys(
  db: Executor,
  chunk: number,
  salaryScope: () => { families: FamilyMatcher; currency: string } | null,
) {
  let companyRows: Promise<{ id: number; name: string }[]> | undefined;
  let salary: ReturnType<typeof salaryScope> | undefined;
  async function* salaryJobIds(row: AgentChangeRow, after: number) {
    if (salary === undefined) salary = salaryScope();
    const scope = salary;
    if (scope === null) return;
    const benchmark = row.keyKind === "benchmark";
    const group = benchmark ? parseBenchmarkKey(row.key) : null;
    if (benchmark && (!group || !scope.currency || group[4] !== scope.currency)) return;
    const candidateCompanies = group ? undefined : (await (companyRows ??= db.select({
      id: companies.id, name: companies.nameNorm,
    }).from(companies))).filter(({ name }) => salaryLookupCompanyMatches(name, row.key)).map(({ id }) => id);
    if (candidateCompanies?.length === 0) return;

    for (;;) {
      const rows = await db.select({
        id: jobs.id, title: jobs.title, titleNorm: jobs.titleNorm, seniority: jobs.seniority,
        companyNorm: companies.nameNorm, locations: jobs.locationsJson,
      }).from(jobs).innerJoin(companies, eq(companies.id, jobs.companyId))
        .where(and(gt(jobs.id, after), candidateCompanies ? inArray(jobs.companyId, candidateCompanies) : undefined))
        .orderBy(asc(jobs.id)).limit(chunk);
      for (const candidate of rows) {
        const job = { ...candidate, location: firstSalaryLocation(candidate.locations) };
        if (group ? matchesSyncSalaryBenchmark(job, group, scope.families) : matchesSyncSalaryLookup(job, row.key, scope.families)) yield job.id;
      }
      if (rows.length < chunk) return;
      after = rows[rows.length - 1]!.id;
    }
  }

  function jobIds(row: AgentChangeRow, after: number): AsyncIterable<number> | Iterable<number> {
    const numericKey = Number(row.key);
    switch (row.keyKind) {
      case "job":
        return numericKey > after ? [numericKey] : [];
      case "company":
        return jobIdPages(after, chunk, (id) => listSyncJobIds(db, id, chunk, eq(jobs.companyId, numericKey)));
      case "raw_posting":
        return jobIdPages(after, chunk, async (id) => {
          const rows = await db.selectDistinct({ id: jobSources.jobId }).from(jobSources)
            .where(and(eq(jobSources.rawPostingId, numericKey), gt(jobSources.jobId, id))).orderBy(asc(jobSources.jobId)).limit(chunk);
          return rows.map(({ id }) => id);
        });
      case "benchmark":
        if (row.key === "*") return jobIdPages(after, chunk, (id) => listSyncJobIds(db, id, chunk));
        return salaryJobIds(row, after);
      case "salary_key":
        return salaryJobIds(row, after);
    }
  }

  return async function* expand(row: AgentChangeRow, after: SyncEntityKey | null, kinds: readonly SyncEntityKind[]) {
    for await (const jobId of jobIds(row, after === null ? 0 : after.jobId - 1)) {
      for (const kind of kinds) {
        const key = { jobId, kind };
        if (after === null || compareSyncEntityKeys(key, after) > 0) yield key;
      }
    }
  };
}
