/** Reads and writes of `company_research` and the `company_research` requests around it. */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { isPublicWebsiteDomain } from "@/lib/ai/web-tasks";
import { COMPANY_RESEARCH_FIELDS, type CompanyResearchView } from "@/lib/research/fields";

import type { Executor } from "../executor";
import { companies, companyResearch, controlRequests, jobs } from "../schema";
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
export function confirmedWebsiteDomain(company: Pick<JobForCompanyResearch, "websiteDomain" | "websiteDomainSource">): string | null {
  if (company.websiteDomainSource !== "user" || company.websiteDomain === null) return null;
  return isPublicWebsiteDomain(company.websiteDomain) ? company.websiteDomain : null;
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

export type CompanyResearchInsert =
  | { status: "ok"; companyId: number; jobId: number; result: CompanyResearchResult; domainUsed: string | null; provider: string | null; model: string | null; promptVersion: number; fetchedAt: Date; expiresAt: Date }
  | { status: "failed"; companyId: number; jobId: number; errorCode: string; domainUsed: string | null; provider: string | null; model: string | null; promptVersion: number; fetchedAt: Date };

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
 * interactive lane and counts as manual); without room it stays where it is and is still joined.
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
      if (input.origin === undefined && isAuto && open.status === "pending" && (await countManual()) < input.maxPerDay) {
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
