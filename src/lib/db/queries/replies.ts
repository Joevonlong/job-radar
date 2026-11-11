import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { ReplyCategory, ReplyState } from "@/lib/replies/types";
import type { Executor } from "../executor";
import { applications, companies, emailReplies, jobs } from "../schema";

export interface ReplyReadFilters {
  state?: ReplyState;
  category?: ReplyCategory;
  since?: Date;
  limit: number;
}

/** Mail content and transport identifiers are never selected by this read surface. */
export function replyReadQuery(db: Executor, filters: ReplyReadFilters) {
  return db.select({
    id: emailReplies.id,
    receivedAt: emailReplies.receivedAt,
    category: emailReplies.category,
    userCategory: emailReplies.userCategory,
    match: emailReplies.match,
    state: emailReplies.state,
    jobId: emailReplies.jobId,
    company: companies.name,
    title: jobs.title,
    applicationStatus: applications.status,
  }).from(emailReplies)
    .leftJoin(jobs, eq(jobs.id, emailReplies.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(applications, eq(applications.id, emailReplies.applicationId))
    .where(replyReadWhere(filters))
    .orderBy(desc(emailReplies.receivedAt), desc(emailReplies.id))
    .limit(filters.limit);
}

function replyReadWhere(filters: ReplyReadFilters) {
  return and(
    filters.state === undefined ? undefined : eq(emailReplies.state, filters.state),
    filters.category === undefined ? undefined : eq(sql`coalesce(${emailReplies.userCategory}, ${emailReplies.category})`, filters.category),
    filters.since === undefined ? undefined : gte(emailReplies.receivedAt, filters.since),
  );
}

export async function listReplyMetadata(db: Executor, filters: ReplyReadFilters) {
  const [rows, totals] = await Promise.all([
    replyReadQuery(db, filters),
    db.select({ total: count() }).from(emailReplies).where(replyReadWhere(filters)),
  ]);
  return { rows, total: totals[0]?.total ?? 0 };
}
