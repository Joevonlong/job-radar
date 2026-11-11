/** Reads and writes of `company_research` and the `company_research` requests around it. */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { isCompanyWebsiteCandidate } from "@/lib/ai/web-tasks";
import { COMPANY_RESEARCH_FIELDS, type CompanyResearchView } from "@/lib/research/fields";

import type { Executor } from "../executor";
import { companies, companyResearch, controlRequests, jobs, jobSources } from "../schema";
import { OPEN_CONTROL_STATUSES, type ControlRequest } from "./control-requests";

export { COMPANY_RESEARCH_FIELDS, type CompanyResearchField, type CompanyResearchView } from "@/lib/research/fields";

const fieldSchema = z.strictObject({ text: z.string().min(1), sourceUrl: z.string().url().startsWith("https://") });

/** The checked answer as stored in `result_json`; read through this schema so a row edited by hand renders nothing unsafe. */
export const companyResearchResultSchema = z.strictObject({
  fields: z.partialRecord(z.enum(COMPANY_RESEARCH_FIELDS), fieldSchema),
  dropped: z.number().int().nonnegative(),
});
export type CompanyResearchResult = z.infer<typeof companyResearchResultSchema>;

export interface JobForCompanyResearch {
  id: number;
  companyId: number;
  company: string;
  websiteDomain: string | null;
  websiteDomainSource: string | null;
}

export async function getJobForCompanyResearch(db: Executor, jobId: number): Promise<JobForCompanyResearch | null> {
  const [row] = await db
    .select({ id: jobs.id, companyId: jobs.companyId, company: companies.name, websiteDomain: companies.websiteDomain, websiteDomainSource: companies.websiteDomainSource })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  return row ?? null;
}

/**
 * The website domain that may leave this machine and open pages on it: only one the user confirmed, and only while it still
 * passes the public-name check (a stored row is not trusted). An inferred domain comes from third-party postings: never here.
 */
export function confirmedWebsiteDomain(company: Pick<JobForCompanyResearch, "websiteDomain" | "websiteDomainSource">, nonCompanyHosts: readonly string[]): string | null {
  if (company.websiteDomainSource !== "user" || company.websiteDomain === null) return null;
  // the host list may have grown since the user confirmed it: a job board is no company's website, whoever said so
  return isCompanyWebsiteCandidate(company.websiteDomain, nonCompanyHosts) ? company.websiteDomain : null;
}

export async function getCompanyRowForDomain(db: Executor, companyId: number): Promise<{ websiteDomain: string | null; websiteDomainSource: string | null } | null> {
  const [row] = await db.select({ websiteDomain: companies.websiteDomain, websiteDomainSource: companies.websiteDomainSource }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return row ?? null;
}

/** The newest posting links of a company's jobs, the apply links first (the employer's own site more often than the source's page). */
export async function listCompanyPostingUrls(db: Executor, companyId: number, limit: number): Promise<string[]> {
  const rows = await db
    .select({ url: jobSources.url, applyUrl: jobSources.applyUrl })
    .from(jobSources)
    .innerJoin(jobs, eq(jobs.id, jobSources.jobId))
    .where(eq(jobs.companyId, companyId))
    .orderBy(desc(jobSources.id))
    .limit(limit);
  return rows.flatMap((row) => [row.applyUrl, row.url]).filter((url): url is string => url !== null);
}

/** Store an inferred website domain, unless the company has one by now. It stays out of every prompt and fetch list until confirmed. */
export async function storeInferredCompanyDomain(db: Executor, input: { companyId: number; domain: string }): Promise<void> {
  await db.update(companies).set({ websiteDomain: input.domain, websiteDomainSource: "inferred" }).where(and(eq(companies.id, input.companyId), isNull(companies.websiteDomain)));
}

/** The user confirms the inferred domain they were shown; false when the stored one is no longer that one. */
export async function confirmInferredCompanyDomain(db: Executor, input: { companyId: number; domain: string; now: Date }): Promise<boolean> {
  const rows = await db
    .update(companies)
    .set({ websiteDomainSource: "user", websiteDomainConfirmedAt: input.now })
    .where(and(eq(companies.id, input.companyId), eq(companies.websiteDomain, input.domain), eq(companies.websiteDomainSource, "inferred")))
    .returning({ id: companies.id });
  return rows.length > 0;
}

/** The user names the website themselves; false when the company no longer exists. */
export async function saveUserCompanyDomain(db: Executor, input: { companyId: number; domain: string; now: Date }): Promise<boolean> {
  const rows = await db.update(companies).set({ websiteDomain: input.domain, websiteDomainSource: "user", websiteDomainConfirmedAt: input.now }).where(eq(companies.id, input.companyId)).returning({ id: companies.id });
  return rows.length > 0;
}

function toView(row: typeof companyResearch.$inferSelect, now: Date): CompanyResearchView | null {
  const parsed = companyResearchResultSchema.safeParse(row.resultJson);
  if (!parsed.success) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
    expired: row.expiresAt !== null && row.expiresAt <= now,
    domainUsed: row.domainUsed,
    provider: row.provider,
    model: row.model,
    fields: parsed.data.fields,
    dropped: parsed.data.dropped,
  };
}

/** The newest good result of a company made with `promptVersion`, expired or not (the cache check; a failed row never counts). */
export async function findLatestCompanyResearch(db: Executor, input: { companyId: number; promptVersion: number; now: Date }): Promise<CompanyResearchView | null> {
  const [row] = await db
    .select()
    .from(companyResearch)
    .where(and(eq(companyResearch.companyId, input.companyId), eq(companyResearch.promptVersion, input.promptVersion), eq(companyResearch.status, "ok")))
    .orderBy(desc(companyResearch.fetchedAt), desc(companyResearch.id))
    .limit(1);
  return row ? toView(row, input.now) : null;
}

export interface CompanyResearchOverviewRow {
  companyId: number;
  websiteDomain: string | null;
  websiteDomainSource: string | null;
  /** The company's newest job: what a refresh from the company list asks through. */
  jobId: number | null;
  latest: CompanyResearchView | null;
}

/** For one page of the company list: each company's newest good result, website and newest job, in one read per kind. */
export async function listCompanyResearchOverview(db: Executor, input: { companyIds: readonly number[]; promptVersion: number; now: Date }): Promise<CompanyResearchOverviewRow[]> {
  if (input.companyIds.length === 0) return [];
  const ids = [...input.companyIds];
  const [rows, results, newest] = await Promise.all([
    db.select({ id: companies.id, websiteDomain: companies.websiteDomain, websiteDomainSource: companies.websiteDomainSource }).from(companies).where(inArray(companies.id, ids)),
    db
      .selectDistinctOn([companyResearch.companyId])
      .from(companyResearch)
      .where(and(inArray(companyResearch.companyId, ids), eq(companyResearch.promptVersion, input.promptVersion), eq(companyResearch.status, "ok")))
      .orderBy(companyResearch.companyId, desc(companyResearch.fetchedAt), desc(companyResearch.id)),
    db.selectDistinctOn([jobs.companyId], { companyId: jobs.companyId, jobId: jobs.id }).from(jobs).where(inArray(jobs.companyId, ids)).orderBy(jobs.companyId, desc(jobs.firstSeenAt), desc(jobs.id)),
  ]);
  const resultOf = new Map(results.map((row) => [row.companyId, toView(row, input.now)]));
  const jobOf = new Map(newest.map((row) => [row.companyId, row.jobId]));
  return rows.map((row) => ({ companyId: row.id, websiteDomain: row.websiteDomain, websiteDomainSource: row.websiteDomainSource, jobId: jobOf.get(row.id) ?? null, latest: resultOf.get(row.id) ?? null }));
}

/** Whether `latest` can stand in for a new lookup: not expired, and made with the domain confirmed now. */
export function companyResearchCurrent(latest: CompanyResearchView | null, confirmedDomain: string | null): boolean {
  return latest !== null && !latest.expired && latest.domainUsed === confirmedDomain;
}

/**
 * What the job page and other readers show for a job's company: its newest good result, of any prompt version, expired
 * or made with another domain included. Failed rows are never returned; no good result is null.
 */
export async function getCompanyResearchForJob(db: Executor, jobId: number, now: Date = new Date()): Promise<CompanyResearchView | null> {
  const [row] = await db
    .select({ research: companyResearch })
    .from(jobs)
    .innerJoin(companyResearch, eq(companyResearch.companyId, jobs.companyId))
    .where(and(eq(jobs.id, jobId), eq(companyResearch.status, "ok")))
    .orderBy(desc(companyResearch.fetchedAt), desc(companyResearch.id))
    .limit(1);
  return row ? toView(row.research, now) : null;
}

/** The newest successful company result and its originating posting, if that posting still belongs to the company. */
export async function getCompanyResearchWithJob(db: Executor, companyId: number, now: Date) {
  const [row] = await db
    .select({ research: companyResearch, job: { jobId: jobs.id, description: jobs.description } })
    .from(companyResearch)
    .leftJoin(jobs, and(eq(jobs.id, companyResearch.jobId), eq(jobs.companyId, companyResearch.companyId)))
    .where(and(eq(companyResearch.companyId, companyId), eq(companyResearch.status, "ok")))
    .orderBy(desc(companyResearch.fetchedAt), desc(companyResearch.id))
    .limit(1);
  if (!row) return null;
  const research = toView(row.research, now);
  return research === null ? null : { research, job: row.job };
}

export type CompanyResearchInsert =
  | { status: "ok"; companyId: number; jobId: number | null; result: CompanyResearchResult; domainUsed: string | null; provider: string | null; model: string | null; promptVersion: number; fetchedAt: Date; expiresAt: Date }
  | { status: "failed"; companyId: number; jobId: number | null; errorCode: string; domainUsed: string | null; provider: string | null; model: string | null; promptVersion: number; fetchedAt: Date };

export async function insertCompanyResearch(db: Executor, input: CompanyResearchInsert): Promise<number> {
  const [row] = await db
    .insert(companyResearch)
    .values({
      companyId: input.companyId,
      jobId: input.jobId,
      status: input.status,
      resultJson: input.status === "ok" ? input.result : null,
      domainUsed: input.domainUsed,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      errorCode: input.status === "failed" ? input.errorCode : null,
      fetchedAt: input.fetchedAt,
      expiresAt: input.status === "ok" ? input.expiresAt : null,
    })
    .returning({ id: companyResearch.id });
  if (!row) throw new Error("insertCompanyResearch: insert returned no row");
  return row.id;
}

/** How often a job's company is read again when a merge removed it at that moment; a merge leaves the job under the kept company. */
const COMPANY_MERGE_READS = 3;

/**
 * Store a finished lookup under the company its job belongs to now: a lookup takes minutes, and a merge in that time removes
 * the company it began with. The company row stays locked until the insert is done, so a merge that starts later waits and
 * then moves this row with the others. Without the job the row stays with `companyId` if that company still exists. Null:
 * neither is left to store it under.
 */
export async function insertCompanyResearchOfJob(db: Executor, input: CompanyResearchInsert & { jobId: number }): Promise<number | null> {
  const { jobId } = input;
  return db.transaction(async (tx) => {
    for (let read = 0; read < COMPANY_MERGE_READS; read += 1) {
      const [company] = await tx.select({ id: companies.id }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(jobs.id, jobId)).for("key share", { of: companies });
      if (company) return insertCompanyResearch(tx, { ...input, companyId: company.id });
      const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
      if (!job) break;
    }
    const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for("key share");
    return company ? insertCompanyResearch(tx, { ...input, jobId: null }) : null;
  });
}

// ---------------------------------------------------------------- requests

export type CompanyResearchReservation =
  | { state: "queued"; requestId: number }
  | { state: "existing"; requestId: number }
  | { state: "quota"; used: number };

/** Advisory lock key of the company lookup quota (any constant; only this code takes it). */
const QUOTA_LOCK = 147_001;

/** Requests of the quota: the kind in the last 24 hours, whatever became of them; automatic ones have their own limit. */
const manualSince = (since: Date) => and(eq(controlRequests.kind, "company_research"), gte(controlRequests.requestedAt, since), sql`${controlRequests.payload} ->> 'origin' is distinct from 'auto'`);

/**
 * Queue a `company_research` request, or join the open one of the same company. The daily quota is checked and the request
 * inserted in one transaction under an advisory lock, so two clicks at once can never both take the last slot. A manual
 * request that joins a waiting automatic one takes it over when the quota has room (`origin` removed, so it moves to the
 * interactive lane and counts as manual); without room it stays where it is and
 * the press gets the quota answer.
 */
export async function reserveCompanyResearchRequest(db: Executor, input: { companyId: number; jobId: number; force: boolean; origin?: "auto"; maxPerDay: number; now: Date }): Promise<CompanyResearchReservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK})`);
    const since = new Date(input.now.getTime() - 86_400_000);
    const countManual = async (): Promise<number> => {
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(controlRequests).where(manualSince(since));
      return count?.n ?? 0;
    };
    const [open] = await tx
      .select({ id: controlRequests.id, status: controlRequests.status, payload: controlRequests.payload })
      .from(controlRequests)
      .where(and(eq(controlRequests.kind, "company_research"), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]), sql`${controlRequests.payload} ->> 'companyId' = ${String(input.companyId)}`))
      .orderBy(controlRequests.id)
      .limit(1);
    if (open) {
      const isAuto = (open.payload as { origin?: unknown } | null)?.origin === "auto";
      if (input.origin === undefined && isAuto && open.status === "pending") {
        const used = await countManual();
        if (used >= input.maxPerDay) return { state: "quota", used };
        await tx.update(controlRequests).set({ payload: sql`${controlRequests.payload} - 'origin'` }).where(and(eq(controlRequests.id, open.id), eq(controlRequests.status, "pending")));
      }
      return { state: "existing", requestId: open.id };
    }
    if (input.origin === undefined) {
      const used = await countManual();
      if (used >= input.maxPerDay) return { state: "quota", used };
    }
    const [row] = await tx
      .insert(controlRequests)
      .values({ kind: "company_research", payload: { jobId: input.jobId, companyId: input.companyId, force: input.force, ...(input.origin ? { origin: input.origin } : {}) }, requestedAt: input.now })
      .returning({ id: controlRequests.id });
    if (!row) throw new Error("reserveCompanyResearchRequest: insert returned no row");
    return { state: "queued", requestId: row.id };
  });
}

/** Manual `company_research` requests in the last 24 hours (the quota's count). */
export async function countCompanyResearchRequests(db: Executor, now: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(controlRequests).where(manualSince(new Date(now.getTime() - 86_400_000)));
  return row?.n ?? 0;
}

/** The open `company_research` request of a company if there is one, else its newest one, or null (what a reloaded page resumes). */
export async function findLatestCompanyResearchRequest(db: Executor, companyId: number): Promise<ControlRequest | null> {
  const byCompany = sql`${controlRequests.payload} ->> 'companyId' = ${String(companyId)}`;
  const [open] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, "company_research"), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]), byCompany))
    .orderBy(desc(controlRequests.id))
    .limit(1);
  if (open) return open;
  const [latest] = await db.select().from(controlRequests).where(and(eq(controlRequests.kind, "company_research"), byCompany)).orderBy(desc(controlRequests.id)).limit(1);
  return latest ?? null;
}

/** Whether the table of this feature exists (a page rendered before the migration ran). */
let tableSeen = false;
export async function companyResearchTableReady(db: Executor): Promise<boolean> {
  if (tableSeen) return true;
  const [row] = await db.execute<{ research: string | null }>(sql`select to_regclass('company_research')::text as research`);
  tableSeen = typeof row?.research === "string";
  return tableSeen;
}

/** The results of company `fromCompanyId` after it was folded into `toCompanyId`; the newest one is then the cached one. */
export async function moveCompanyResearch(db: Executor, input: { fromCompanyId: number; toCompanyId: number }): Promise<number> {
  const moved = await db.update(companyResearch).set({ companyId: input.toCompanyId }).where(eq(companyResearch.companyId, input.fromCompanyId)).returning({ id: companyResearch.id });
  return moved.length;
}
