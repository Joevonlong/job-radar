import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { applications, companies, interestSuggestions, jobs } from "../schema";

export type InterestSuggestion = typeof interestSuggestions.$inferSelect;
export type SuggestionStatus = InterestSuggestion["status"];
export type ApplicationStatusValue = (typeof applications.$inferSelect)["status"];

export interface SuggestionSourceJob {
  jobId: number;
  title: string;
  companyName: string;
  companyNorm: string;
  locationsJson: unknown;
  workplace: string;
  seniority: string;
  skills: string[];
  description: string;
  applicationStatus: ApplicationStatusValue;
  statusChangedAt: Date;
}

/**
 * Jobs the user acted on: applications in one of `statuses` whose status changed at or after `since`, the furthest
 * status first and the newest within it, at most `limit` (a bound on the work; `selectCandidates` picks the final set). Jobs without a description are left out:
 * there is nothing to quote.
 */
export async function listSuggestionSourceJobs(
  db: Executor,
  input: { statuses: readonly ApplicationStatusValue[]; since: Date; limit: number },
): Promise<SuggestionSourceJob[]> {
  if (input.statuses.length === 0) return [];
  const rows = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      companyName: companies.name,
      companyNorm: companies.nameNorm,
      locationsJson: jobs.locationsJson,
      workplace: jobs.workplace,
      seniority: jobs.seniority,
      skills: jobs.skills,
      description: jobs.description,
      applicationStatus: applications.status,
      statusChangedAt: applications.statusChangedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(inArray(applications.status, [...input.statuses]), gte(applications.statusChangedAt, input.since)))
    // the enum is declared in pipeline order: the furthest status first, then the newest change
    .orderBy(desc(applications.status), desc(applications.statusChangedAt), desc(applications.id))
    .limit(input.limit);
  return rows.flatMap((row) => (row.description === null || row.description.trim() === "" ? [] : [{ ...row, description: row.description }]));
}

export interface NewSuggestion {
  kind: string;
  dedupeKey: string;
  payload: unknown;
}

/** Store suggestions as pending; one whose `dedupeKey` exists (in any status) is skipped. Returns the rows that were stored. */
export async function insertSuggestions(db: Executor, items: readonly NewSuggestion[]): Promise<InterestSuggestion[]> {
  if (items.length === 0) return [];
  return db
    .insert(interestSuggestions)
    .values(items.map((item) => ({ kind: item.kind, dedupeKey: item.dedupeKey, payloadJson: item.payload })))
    .onConflictDoNothing({ target: interestSuggestions.dedupeKey })
    .returning();
}

/** Which of `keys` were suggested before (any status). */
export async function findExistingDedupeKeys(db: Executor, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.select({ key: interestSuggestions.dedupeKey }).from(interestSuggestions).where(inArray(interestSuggestions.dedupeKey, [...keys]));
  return new Set(rows.map((r) => r.key));
}

export async function getSuggestion(db: Executor, id: number): Promise<InterestSuggestion | null> {
  const [row] = await db.select().from(interestSuggestions).where(eq(interestSuggestions.id, id)).limit(1);
  return row ?? null;
}

/** Suggestions with `status`, newest first (the page lists the pending ones; the decided ones are a short history). */
export async function listSuggestions(db: Executor, input: { status: SuggestionStatus | readonly SuggestionStatus[]; limit: number }): Promise<InterestSuggestion[]> {
  const statuses = Array.isArray(input.status) ? [...input.status] : [input.status as SuggestionStatus];
  return db
    .select()
    .from(interestSuggestions)
    .where(inArray(interestSuggestions.status, statuses))
    .orderBy(desc(interestSuggestions.createdAt), desc(interestSuggestions.id))
    .limit(input.limit);
}

export async function countSuggestions(db: Executor, status: SuggestionStatus): Promise<number> {
  const [row] = await db.select({ n: count() }).from(interestSuggestions).where(eq(interestSuggestions.status, status));
  return row?.n ?? 0;
}

/**
 * Decide a pending suggestion. Only a pending one changes (two clicks, or two tabs, decide it once); returns the
 * updated row, or null when the suggestion does not exist or was decided already.
 */
export async function decideSuggestion(db: Executor, id: number, status: Exclude<SuggestionStatus, "pending">): Promise<InterestSuggestion | null> {
  const [row] = await db
    .update(interestSuggestions)
    .set({ status, decidedAt: sql`now()` })
    .where(and(eq(interestSuggestions.id, id), eq(interestSuggestions.status, "pending")))
    .returning();
  return row ?? null;
}

/** Put a decided suggestion back to pending (the config write that should have followed the decision failed). */
export async function reopenSuggestion(db: Executor, id: number): Promise<void> {
  await db.update(interestSuggestions).set({ status: "pending", decidedAt: null }).where(eq(interestSuggestions.id, id));
}
