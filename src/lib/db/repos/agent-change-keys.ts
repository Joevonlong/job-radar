import { and, asc, eq, gt, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { FamilyMatcher } from "@/lib/salary/families";
import { salaryGroupCandidates } from "@/lib/salary/groups";
import { salaryLookupCompanyMatches, salaryLookupKey } from "@/lib/salary/lookup-key";

import type { Executor } from "../executor";
import { applications, companies, jobFavorites, jobs, jobSources } from "../schema";
import { compareSyncEntityKeys, type SyncEntityKey } from "../sync-position";
import { SYNC_REMOVED_BITS, type SyncEntityKind } from "../sync-sources";
import type { AgentChangeRow } from "./agent-changes";
import { firstSalaryLocation, type JobForSalaryLookup } from "./salary-lookups";

export async function listSyncJobKeys(db: Executor, after: SyncEntityKey | null, limit: number): Promise<SyncEntityKey[]> {
  const rows = await db.select({ id: jobs.id }).from(jobs)
    .where(gt(jobs.id, after?.jobId ?? 0)).orderBy(asc(jobs.id)).limit(limit);
  return rows.map(({ id }) => ({ jobId: id, kind: "job" }));
}

const trackingKinds = ["application", "favorite"] as const;
const trackingTables = { application: applications, favorite: jobFavorites } as const;
type TrackingKind = (typeof trackingKinds)[number];
type JobIdColumn = typeof jobs.id | typeof jobSources.jobId;

export async function listSyncTrackingKeys(db: Executor, after: SyncEntityKey | null, limit: number, kinds: readonly SyncEntityKind[]): Promise<SyncEntityKey[]> {
  const selected = trackingKinds.filter((kind) => kinds.includes(kind));
  const pages = await Promise.all(selected.map(async (kind) => {
    const table = trackingTables[kind];
    const at = after?.jobId ?? 0;
    const bound = after !== null && compareSyncEntityKeys({ jobId: at, kind }, after) > 0 ? gte : gt;
    const rows = await db.select({ jobId: table.jobId }).from(table)
      .where(bound(table.jobId, at)).orderBy(asc(table.jobId)).limit(limit);
    return rows.map(({ jobId }) => ({ jobId, kind }));
  }));
  return pages.flat().sort(compareSyncEntityKeys).slice(0, limit);
}

function trackingMembership(jobId: JobIdColumn, kinds: readonly SyncEntityKind[]) {
  const present = (kind: TrackingKind) => {
    if (!kinds.includes(kind)) return sql<boolean>`false`;
    const table = trackingTables[kind];
    return sql<boolean>`exists (select 1 from ${table} where ${eq(table.jobId, jobId)})`;
  };
  const application = present("application");
  const favorite = present("favorite");
  return { columns: { application, favorite }, filter: kinds.includes("job") ? undefined : or(application, favorite) };
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

async function* jobPages<Row extends { id: number }>(after: number, chunk: number, read: (after: number) => Promise<Row[]>) {
  for (;;) {
    const rows = await read(after);
    yield* rows;
    if (rows.length < chunk) return;
    after = rows[rows.length - 1]!.id;
  }
}

type Candidate = { id: number; application: boolean; favorite: boolean };

/** Resolve shared keys against the current snapshot. Jobs in the archive have the same dependencies as other jobs. */
export function expandAgentChangeKeys(
  db: Executor,
  chunk: number,
  salaryScope: () => { families: FamilyMatcher; currency: string } | null,
) {
  let companyRows: Promise<{ id: number; name: string }[]> | undefined;
  let salary: ReturnType<typeof salaryScope> | undefined;
  async function* salaryJobs(row: AgentChangeRow, after: number, kinds: readonly SyncEntityKind[]) {
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

    const membership = trackingMembership(jobs.id, kinds);
    const candidates = jobPages(after, chunk, async (id) => db.select({
      id: jobs.id, title: jobs.title, titleNorm: jobs.titleNorm, seniority: jobs.seniority,
      companyNorm: companies.nameNorm, locations: jobs.locationsJson, ...membership.columns,
    }).from(jobs).innerJoin(companies, eq(companies.id, jobs.companyId))
      .where(and(gt(jobs.id, id), membership.filter, candidateCompanies ? inArray(jobs.companyId, candidateCompanies) : undefined))
      .orderBy(asc(jobs.id)).limit(chunk));
    for await (const candidate of candidates) {
      const job = { ...candidate, location: firstSalaryLocation(candidate.locations) };
      if (group ? matchesSyncSalaryBenchmark(job, group, scope.families) : matchesSyncSalaryLookup(job, row.key, scope.families)) yield candidate;
    }
  }

  async function* directJob(row: AgentChangeRow, jobId: number, after: number, kinds: readonly SyncEntityKind[]) {
    if (!(jobId > after)) return;
    const needed = kinds.filter((kind) => kind !== "job" && !wasRemoved(row, kind));
    const [current] = needed.length === 0 ? [] : await db.select(trackingMembership(jobs.id, needed).columns)
      .from(jobs).where(eq(jobs.id, jobId));
    yield { id: jobId, application: current?.application ?? false, favorite: current?.favorite ?? false };
  }

  function sharedJobs(after: number, kinds: readonly SyncEntityKind[], filter?: SQL) {
    const membership = trackingMembership(jobs.id, kinds);
    return jobPages(after, chunk, async (id) => db.select({ id: jobs.id, ...membership.columns }).from(jobs)
      .where(and(gt(jobs.id, id), membership.filter, filter)).orderBy(asc(jobs.id)).limit(chunk));
  }

  function candidates(row: AgentChangeRow, after: number, kinds: readonly SyncEntityKind[]): AsyncIterable<Candidate> {
    const numericKey = Number(row.key);
    switch (row.keyKind) {
      case "job":
        return directJob(row, numericKey, after, kinds);
      case "company":
        return sharedJobs(after, kinds, eq(jobs.companyId, numericKey));
      case "raw_posting": {
        const membership = trackingMembership(jobSources.jobId, kinds);
        return jobPages(after, chunk, async (id) => db.selectDistinct({ id: jobSources.jobId, ...membership.columns }).from(jobSources)
          .where(and(eq(jobSources.rawPostingId, numericKey), gt(jobSources.jobId, id), membership.filter))
          .orderBy(asc(jobSources.jobId)).limit(chunk));
      }
      case "benchmark":
        if (row.key === "*") return sharedJobs(after, kinds);
        return salaryJobs(row, after, kinds);
      case "salary_key":
        return salaryJobs(row, after, kinds);
    }
  }

  return async function* expand(row: AgentChangeRow, after: SyncEntityKey | null, kinds: readonly SyncEntityKind[]) {
    for await (const candidate of candidates(row, after === null ? 0 : after.jobId - 1, kinds)) {
      for (const kind of kinds) {
        if (kind !== "job" && !candidate[kind] && !wasRemoved(row, kind)) continue;
        const key = { jobId: candidate.id, kind };
        if (after === null || compareSyncEntityKeys(key, after) > 0) yield key;
      }
    }
  };
}

function wasRemoved(row: AgentChangeRow, kind: SyncEntityKind): boolean {
  return row.keyKind === "job" && (row.removed & (1 << SYNC_REMOVED_BITS[kind])) !== 0;
}
