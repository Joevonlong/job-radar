import { and, asc, eq, gt, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { FamilyMatcher } from "@/lib/salary/families";
import { salaryGroupCandidates } from "@/lib/salary/groups";
import { salaryLookupKey } from "@/lib/salary/lookup-key";

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
type SyncBenchmarkKey = z.infer<typeof groupKey>;

function parseBenchmarkKey(key: string): SyncBenchmarkKey | null {
  const parsed = groupKey.safeParse(JSON.parse(key));
  return parsed.success ? parsed.data : null;
}

type Candidate = { id: number; application: boolean; favorite: boolean };
type SalaryCandidate = Candidate & Pick<JobForSalaryLookup, "title" | "titleNorm" | "seniority" | "companyNorm" | "location">;

function addCandidate(index: Map<string, Candidate[]>, key: string, candidate: Candidate): void {
  const matches = index.get(key);
  if (matches) matches.push(candidate);
  else index.set(key, [candidate]);
}

export function indexSyncSalaryCandidates(candidates: readonly SalaryCandidate[], families: FamilyMatcher, currency: string) {
  const lookups = new Map<string, Candidate[]>();
  const benchmarks = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const family = families.familyOf(candidate.title);
    addCandidate(lookups, salaryLookupKey(candidate, family), candidate);
    if (family === null || !currency) continue;
    const groups = salaryGroupCandidates({
      seniority: candidate.seniority, city: candidate.location?.city ?? null, country: candidate.location?.countryCode ?? null,
    });
    const keys = new Set(groups.map(({ seniority, geoLevel, geoKey }) => JSON.stringify([family, seniority, geoLevel, geoKey, currency])));
    for (const key of keys) addCandidate(benchmarks, key, candidate);
  }
  return {
    lookup: (key: string) => lookups.get(key) ?? [],
    benchmark: (key: SyncBenchmarkKey) => benchmarks.get(JSON.stringify(key)) ?? [],
  };
}

async function* jobPages<Row extends { id: number }>(after: number, chunk: number, read: (after: number) => Promise<Row[]>) {
  for (;;) {
    const rows = await read(after);
    yield* rows;
    if (rows.length < chunk) return;
    after = rows[rows.length - 1]!.id;
  }
}

function readSalaryCandidates(db: Executor, kinds: readonly SyncEntityKind[]) {
  const membership = trackingMembership(jobs.id, kinds);
  const location = sql`case when jsonb_typeof(${jobs.locationsJson}) = 'array' then ${jobs.locationsJson} -> 0 end`
    .mapWith((value: unknown) => firstSalaryLocation([value]));
  return db.select({
    id: jobs.id, title: jobs.title, titleNorm: jobs.titleNorm, seniority: jobs.seniority,
    companyNorm: companies.nameNorm, location, ...membership.columns,
  }).from(jobs).innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(membership.filter).orderBy(asc(jobs.id));
}

/** Resolve shared keys against the current snapshot. Jobs in the archive have the same dependencies as other jobs. */
export function expandAgentChangeKeys(
  db: Executor,
  chunk: number,
  selection: { mask: number; kindsFor: (blocks: number) => readonly SyncEntityKind[] },
  salaryScope: () => { families: FamilyMatcher; currency: string } | null,
) {
  const selectedKinds = selection.kindsFor(selection.mask);
  let directMembers = new Map<number, Candidate>();
  let salaryIndex: Promise<ReturnType<typeof indexSyncSalaryCandidates>> | undefined;
  let salary: ReturnType<typeof salaryScope> | undefined;

  async function prepareRows(rows: readonly AgentChangeRow[]) {
    if (selectedKinds.every((kind) => kind === "job")) return;
    const ids = new Set<number>();
    for (const row of rows) {
      if (row.keyKind !== "job" || !selection.kindsFor(row.blocks).some((kind) => kind !== "job" && !wasRemoved(row, kind))) continue;
      const id = Number(row.key);
      if (id > 0) ids.add(id);
    }
    const members = ids.size === 0 ? [] : await db.select({ id: jobs.id, ...trackingMembership(jobs.id, selectedKinds).columns })
      .from(jobs).where(inArray(jobs.id, [...ids]));
    directMembers = new Map(members.map((member) => [member.id, member]));
  }

  async function* salaryJobs(row: AgentChangeRow, after: number) {
    if (salary === undefined) salary = salaryScope();
    const scope = salary;
    if (scope === null) return;
    const benchmark = row.keyKind === "benchmark";
    const group = benchmark ? parseBenchmarkKey(row.key) : null;
    if (benchmark && (!group || !scope.currency || group[4] !== scope.currency)) return;
    const index = await (salaryIndex ??= readSalaryCandidates(db, selectedKinds)
      .then((candidates) => indexSyncSalaryCandidates(candidates, scope.families, scope.currency)));
    for (const candidate of group ? index.benchmark(group) : index.lookup(row.key)) {
      if (candidate.id > after) yield candidate;
    }
  }

  function* directJob(jobId: number, after: number) {
    if (jobId > after) yield directMembers.get(jobId) ?? { id: jobId, application: false, favorite: false };
  }

  function sharedJobs(after: number, kinds: readonly SyncEntityKind[], filter?: SQL) {
    const membership = trackingMembership(jobs.id, kinds);
    return jobPages(after, chunk, async (id) => db.select({ id: jobs.id, ...membership.columns }).from(jobs)
      .where(and(gt(jobs.id, id), membership.filter, filter)).orderBy(asc(jobs.id)).limit(chunk));
  }

  function candidates(row: AgentChangeRow, after: number, kinds: readonly SyncEntityKind[]): Iterable<Candidate> | AsyncIterable<Candidate> {
    const numericKey = Number(row.key);
    switch (row.keyKind) {
      case "job":
        return directJob(numericKey, after);
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
        return salaryJobs(row, after);
      case "salary_key":
        return salaryJobs(row, after);
    }
  }

  async function* expand(row: AgentChangeRow, after: SyncEntityKey | null) {
    const kinds = selection.kindsFor(row.blocks);
    for await (const candidate of candidates(row, after === null ? 0 : after.jobId - 1, kinds)) {
      for (const kind of kinds) {
        if (kind !== "job" && !candidate[kind] && !wasRemoved(row, kind)) continue;
        const key = { jobId: candidate.id, kind };
        if (after === null || compareSyncEntityKeys(key, after) > 0) yield key;
      }
    }
  }

  return { prepareRows, expand };
}

function wasRemoved(row: AgentChangeRow, kind: SyncEntityKind): boolean {
  return row.keyKind === "job" && (row.removed & (1 << SYNC_REMOVED_BITS[kind])) !== 0;
}
