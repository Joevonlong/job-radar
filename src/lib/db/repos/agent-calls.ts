import { and, count, desc, eq, gte, lt, max, sql, type SQL } from "drizzle-orm";

import { createConnection, databaseUrlFor, type Db } from "../client";
import type { Executor } from "../executor";
import { agentCalls, agentTokens, applicationQuestions, applications, companies, jobs } from "../schema";

export type AgentCallRow = Omit<typeof agentCalls.$inferSelect, "id" | "calledAt">;

export function openAgentCallsConnection(source: string | Db, options: { connectTimeoutSeconds: number; statementTimeoutMs: number; lockTimeoutMs: number }) {
  return createConnection(typeof source === "string" ? source : databaseUrlFor(source), {
    max: 1,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
    sessionSettings: {
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      idle_in_transaction_session_timeout: options.statementTimeoutMs,
    },
  });
}

export async function insertAgentCall(db: Executor, row: AgentCallRow): Promise<number> {
  const [added] = await db.insert(agentCalls).values(row).returning({ id: agentCalls.id });
  return added.id;
}

/** The foreign key also removes each expired call's local undo data. */
export async function pruneAgentCalls(db: Executor, olderThan: Date): Promise<number> {
  const rows = await db.delete(agentCalls).where(lt(agentCalls.calledAt, olderThan)).returning({ id: agentCalls.id });
  return rows.length;
}

/** When any agent last made a call that was recorded; null before the first one. */
export async function latestAgentCallAt(db: Executor): Promise<Date | null> {
  const [row] = await db.select({ at: max(agentCalls.calledAt) }).from(agentCalls);
  return row?.at ?? null;
}

/** The results an audit row can have; the activity filter offers exactly these. */
export const AGENT_CALL_OUTCOMES = agentCalls.outcome.enumValues;

export interface AgentCallFilter {
  /** `stdio` or a token id. */
  connection?: "stdio" | number;
  capability?: string;
  outcome?: string;
  since?: Date;
}

/** Where the next page starts: the time at the database's microsecond precision, as the text `listAgentCalls` returned, and the id. */
export interface AgentCallCursor { at: string; id: number }

export interface AgentCallListRow {
  id: number;
  calledAt: Date;
  cursorAt: string;
  caller: string;
  tokenId: number | null;
  tokenName: string | null;
  tokenRevoked: boolean;
  transport: string;
  capability: string;
  targetType: "job" | "application" | "question" | null;
  targetId: number | null;
  jobId: number | null;
  jobTitle: string | null;
  company: string | null;
  outcome: string;
  errorCategory: string | null;
  returnedCount: number;
  durationMs: number;
}

function whereOf(filter: AgentCallFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.connection === "stdio") parts.push(eq(agentCalls.caller, "stdio"));
  else if (filter.connection !== undefined) parts.push(eq(agentCalls.tokenId, filter.connection));
  if (filter.capability !== undefined) parts.push(eq(agentCalls.capability, filter.capability));
  if (filter.outcome !== undefined) parts.push(eq(agentCalls.outcome, filter.outcome as (typeof AGENT_CALL_OUTCOMES)[number]));
  if (filter.since !== undefined) parts.push(gte(agentCalls.calledAt, filter.since));
  return parts.length === 0 ? undefined : and(...parts);
}

/**
 * Newest first, keyset-paged on (called_at, id) so rows sharing an instant are neither repeated nor skipped. A target that is an
 * application or a question is resolved to its job; one that no longer exists leaves the job columns null.
 */
export async function listAgentCalls(db: Executor, input: { filter: AgentCallFilter; limit: number; after?: AgentCallCursor }): Promise<{ rows: AgentCallListRow[]; hasMore: boolean }> {
  const cursorAt = sql<string>`to_char(${agentCalls.calledAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const conditions = [whereOf(input.filter)];
  if (input.after) conditions.push(sql`(${agentCalls.calledAt}, ${agentCalls.id}) < (${input.after.at}::timestamptz, ${input.after.id})`);
  const rows = await db
    .select({
      id: agentCalls.id,
      calledAt: agentCalls.calledAt,
      cursorAt,
      caller: agentCalls.caller,
      tokenId: agentCalls.tokenId,
      tokenName: agentTokens.name,
      tokenRevokedAt: agentTokens.revokedAt,
      transport: agentCalls.transport,
      capability: agentCalls.capability,
      targetType: agentCalls.targetType,
      targetId: agentCalls.targetId,
      jobId: jobs.id,
      jobTitle: jobs.title,
      company: companies.name,
      outcome: agentCalls.outcome,
      errorCategory: agentCalls.errorCategory,
      returnedCount: agentCalls.returnedCount,
      durationMs: agentCalls.durationMs,
    })
    .from(agentCalls)
    .leftJoin(agentTokens, eq(agentTokens.id, agentCalls.tokenId))
    .leftJoin(applications, and(eq(agentCalls.targetType, "application"), eq(applications.id, agentCalls.targetId)))
    .leftJoin(applicationQuestions, and(eq(agentCalls.targetType, "question"), eq(applicationQuestions.id, agentCalls.targetId)))
    .leftJoin(jobs, sql`${jobs.id} = case ${agentCalls.targetType} when 'job' then ${agentCalls.targetId} when 'application' then ${applications.jobId} when 'question' then ${applicationQuestions.jobId} end`)
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(...conditions))
    .orderBy(desc(agentCalls.calledAt), desc(agentCalls.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit).map(({ tokenRevokedAt, ...row }) => ({ ...row, tokenRevoked: tokenRevokedAt !== null }));
  return { rows: page, hasMore: rows.length > input.limit };
}

/** Calls per result within the filter. */
export async function summarizeAgentCalls(db: Executor, filter: AgentCallFilter): Promise<Record<string, number>> {
  const rows = await db.select({ outcome: agentCalls.outcome, calls: count() }).from(agentCalls).where(whereOf(filter)).groupBy(agentCalls.outcome);
  return Object.fromEntries(rows.map((row) => [row.outcome, row.calls]));
}

/** Every token, revoked ones included: the connection filter lists them all. */
export async function agentCallConnections(db: Executor): Promise<{ id: number; name: string; revoked: boolean }[]> {
  const rows = await db.select({ id: agentTokens.id, name: agentTokens.name, revokedAt: agentTokens.revokedAt }).from(agentTokens).orderBy(desc(agentTokens.id));
  return rows.map((row) => ({ id: row.id, name: row.name, revoked: row.revokedAt !== null }));
}
