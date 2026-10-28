/** Reads and writes of `salary_lookups` and the `salary_lookup` requests around them (C9). */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { rekeySalaryLookupKey } from "@/lib/salary/lookup-key";
import { salaryLookupResultSchema, type SalaryLookupResult } from "@/lib/salary/lookup-types";
import { jobLocationSchema, type JobLocation } from "@/lib/domain/types";

import type { Executor } from "../executor";
import { companies, controlRequests, jobs, salaryLookups } from "../schema";
import { OPEN_CONTROL_STATUSES, type ControlRequest } from "./control-requests";

export type SalaryLookupRow = typeof salaryLookups.$inferSelect;

export interface JobForSalaryLookup {
  id: number;
  title: string;
  titleNorm: string;
  seniority: string;
  companyId: number;
  company: string;
  companyNorm: string;
  /** The first location of the posting. */
  location: JobLocation | null;
}

export async function getJobForSalaryLookup(db: Executor, jobId: number): Promise<JobForSalaryLookup | null> {
  const [row] = await db
    .select({ id: jobs.id, title: jobs.title, titleNorm: jobs.titleNorm, seniority: jobs.seniority, companyId: jobs.companyId, company: companies.name, companyNorm: companies.nameNorm, locations: jobs.locationsJson })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row) return null;
  const first = Array.isArray(row.locations) && row.locations.length > 0 ? jobLocationSchema.safeParse(row.locations[0]) : null;
  return { id: row.id, title: row.title, titleNorm: row.titleNorm, seniority: row.seniority, companyId: row.companyId, company: row.company, companyNorm: row.companyNorm, location: first?.success ? first.data : null };
}

export interface StoredSalaryLookup {
  id: number;
  lookupKey: string;
  jobId: number | null;
  origin: { jobId: number; title: string } | null;
  result: SalaryLookupResult;
  provider: string | null;
  model: string | null;
  fetchedAt: Date;
  expiresAt: Date;
}

const toStored = (row: SalaryLookupRow, origin: StoredSalaryLookup["origin"]): StoredSalaryLookup | null => {
  const parsed = salaryLookupResultSchema.safeParse(row.resultJson);
  if (!parsed.success) return null;
  return { id: row.id, lookupKey: row.lookupKey, jobId: row.jobId, origin, result: parsed.data, provider: row.provider, model: row.model, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt };
};

/** The newest finished lookup of `lookupKey` made with `promptVersion` (expired or not; the caller compares `expiresAt`). */
export async function findLatestSalaryLookup(db: Executor, input: { lookupKey: string; promptVersion: string }): Promise<StoredSalaryLookup | null> {
  const [row] = await db
    .select({ lookup: salaryLookups, origin: { jobId: jobs.id, title: jobs.title } })
    .from(salaryLookups)
    .leftJoin(jobs, eq(jobs.id, salaryLookups.jobId))
    .where(and(eq(salaryLookups.lookupKey, input.lookupKey), eq(salaryLookups.status, "done"), eq(salaryLookups.promptVersion, input.promptVersion)))
    .orderBy(desc(salaryLookups.fetchedAt), desc(salaryLookups.id))
    .limit(1);
  return row ? toStored(row.lookup, row.origin) : null;
}

export interface SalaryLookupInsert {
  companyId: number;
  jobId: number;
  lookupKey: string;
  status: "done" | "failed";
  result: SalaryLookupResult | null;
  confidence: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  errorCode: string | null;
  fetchedAt: Date;
  expiresAt: Date;
}

export async function insertSalaryLookup(db: Executor, input: SalaryLookupInsert): Promise<number> {
  const [row] = await db
    .insert(salaryLookups)
    .values({
      companyId: input.companyId,
      jobId: input.jobId,
      lookupKey: input.lookupKey,
      status: input.status,
      resultJson: input.result,
      confidence: input.confidence,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      errorCode: input.errorCode,
      fetchedAt: input.fetchedAt,
      expiresAt: input.expiresAt,
    })
    .returning({ id: salaryLookups.id });
  if (!row) throw new Error("insertSalaryLookup: insert returned no row");
  return row.id;
}

// ---------------------------------------------------------------- requests

export type SalaryReservation =
  | { state: "queued"; requestId: number }
  | { state: "existing"; requestId: number }
  | { state: "quota"; used: number };

/** Advisory lock key of the salary lookup quota (any constant; only this code takes it). */
const QUOTA_LOCK = 118_001;

/**
 * Queue a `salary_lookup` request, or join an open one for the same key. The daily quota (`maxPerDay` requests in the last
 * 24 hours, whatever became of them) is checked and the request inserted in one transaction under an advisory lock, so two
 * clicks at once can never both take the last slot.
 */
export async function reserveSalaryLookupRequest(db: Executor, input: { lookupKey: string; jobId: number; force: boolean; maxPerDay: number; now: Date }): Promise<SalaryReservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK})`);
    const [open] = await tx
      .select({ id: controlRequests.id })
      .from(controlRequests)
      .where(and(eq(controlRequests.kind, "salary_lookup"), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]), sql`${controlRequests.payload} ->> 'lookupKey' = ${input.lookupKey}`))
      .orderBy(controlRequests.id)
      .limit(1);
    if (open) return { state: "existing", requestId: open.id };
    const since = new Date(input.now.getTime() - 86_400_000);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(controlRequests)
      .where(and(eq(controlRequests.kind, "salary_lookup"), gte(controlRequests.requestedAt, since)));
    const used = count?.n ?? 0;
    if (used >= input.maxPerDay) return { state: "quota", used };
    const [row] = await tx
      .insert(controlRequests)
      .values({ kind: "salary_lookup", payload: { jobId: input.jobId, force: input.force, lookupKey: input.lookupKey }, requestedAt: input.now })
      .returning({ id: controlRequests.id });
    if (!row) throw new Error("reserveSalaryLookupRequest: insert returned no row");
    return { state: "queued", requestId: row.id };
  });
}

/** `salary_lookup` requests in the last 24 hours (the quota's count). */
export async function countSalaryLookupRequests(db: Executor, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, "salary_lookup"), gte(controlRequests.requestedAt, since)));
  return row?.n ?? 0;
}

/** The open `salary_lookup` request of a key if there is one, else the newest one of the job, or null (what a reloaded page resumes). */
export async function findLatestSalaryLookupRequest(db: Executor, input: { lookupKey: string; jobId: number }): Promise<ControlRequest | null> {
  const [open] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, "salary_lookup"), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]), sql`${controlRequests.payload} ->> 'lookupKey' = ${input.lookupKey}`))
    .orderBy(desc(controlRequests.id))
    .limit(1);
  if (open) return open;
  const [latest] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, "salary_lookup"), sql`${controlRequests.payload} ->> 'jobId' = ${String(input.jobId)}`))
    .orderBy(desc(controlRequests.id))
    .limit(1);
  return latest ?? null;
}

/**
 * The lookups of company `fromCompanyId` after its key changed from `fromNorm` to `toNorm`, or after it was folded into
 * `toCompanyId`: they move to that company and their cache keys follow the new company key (`rekeySalaryLookupKey`), so a
 * paid lookup is neither deleted with the old row nor lost to the new key. Returns the number of lookups moved.
 */
export async function moveSalaryLookups(db: Executor, input: { fromCompanyId: number; toCompanyId: number; fromNorm: string; toNorm: string }): Promise<number> {
  const rows = await db.select({ id: salaryLookups.id, lookupKey: salaryLookups.lookupKey }).from(salaryLookups).where(eq(salaryLookups.companyId, input.fromCompanyId));
  for (const row of rows) {
    const lookupKey = input.fromNorm === input.toNorm ? null : rekeySalaryLookupKey(row.lookupKey, "company", input.fromNorm, input.toNorm);
    await db
      .update(salaryLookups)
      .set({ companyId: input.toCompanyId, ...(lookupKey !== null ? { lookupKey } : {}) })
      .where(eq(salaryLookups.id, row.id));
  }
  return rows.length;
}

/** The cache keys of the jobs' lookups after their title keys changed (`from` -> `to` per job). */
export async function rekeySalaryLookupTitles(db: Executor, changes: ReadonlyArray<{ jobId: number; from: string; to: string }>): Promise<number> {
  if (changes.length === 0) return 0;
  const byJob = new Map(changes.map((change) => [change.jobId, change]));
  const rows = await db
    .select({ id: salaryLookups.id, jobId: salaryLookups.jobId, lookupKey: salaryLookups.lookupKey })
    .from(salaryLookups)
    .where(inArray(salaryLookups.jobId, [...byJob.keys()]));
  let changed = 0;
  for (const row of rows) {
    const change = row.jobId === null ? undefined : byJob.get(row.jobId);
    const lookupKey = change ? rekeySalaryLookupKey(row.lookupKey, "title", change.from, change.to) : null;
    if (lookupKey === null) continue;
    await db.update(salaryLookups).set({ lookupKey }).where(eq(salaryLookups.id, row.id));
    changed += 1;
  }
  return changed;
}
