/** Statistics over `ai_usage` for /sources/ai-usage. Read-only. */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { aiUsage, companies, jobs } from "../schema";

export interface AiUsageFilter {
  /** First and last day (inclusive, `YYYY-MM-DD`) in `timeZone`. */
  from: string;
  to: string;
  timeZone: string;
  provider?: string | undefined;
  model?: string | undefined;
  task?: string | undefined;
}

/** One row per (day, provider, model, model_source, task, outcome): small enough to aggregate further in TypeScript. */
export interface AiUsageGroup {
  day: string;
  provider: string;
  model: string | null;
  modelSource: string | null;
  task: string;
  outcome: string | null;
  calls: number;
  /** calls whose token counts are known */
  tokenCalls: number;
  tokensIn: number;
  tokensInCached: number;
  /** calls whose cached-input count is known (rows written before AI usage tracking have NULL) */
  cachedCalls: number;
  tokensInCacheWrite: number;
  tokensOut: number;
  tokensOutReasoning: number;
  /** calls whose reasoning-output count is known */
  reasoningCalls: number;
  durationMsSum: number;
  durationCalls: number;
  equivalentUsd: number;
  equivalentCalls: number;
  actualUsd: number;
  /** calls whose actual spend is known: subscription calls (always 0) and API calls with token counts */
  actualCalls: number;
  /** Σ cost_estimate over the calls that have an equivalent cost (for the savings figure) */
  actualUsdWithEquivalent: number;
}

function window(filter: AiUsageFilter): SQL {
  const conditions: SQL[] = [
    sql`${aiUsage.at} >= (${filter.from}::date)::timestamp at time zone ${filter.timeZone}`,
    sql`${aiUsage.at} < ((${filter.to}::date + 1))::timestamp at time zone ${filter.timeZone}`,
  ];
  if (filter.provider !== undefined) conditions.push(eq(aiUsage.provider, filter.provider));
  if (filter.model !== undefined) conditions.push(eq(aiUsage.model, filter.model));
  if (filter.task !== undefined) conditions.push(eq(aiUsage.task, filter.task));
  return and(...conditions) as SQL;
}

const num = (value: unknown): number => Number(value ?? 0);

/** `apiProviders`: providers billed per token; for them the actual spend is unknown when the call has no token counts. */
export async function getAiUsageGroups(db: Db, filter: AiUsageFilter, apiProviders: readonly string[]): Promise<AiUsageGroup[]> {
  const day = sql<string>`to_char(${aiUsage.at} at time zone ${filter.timeZone}, 'YYYY-MM-DD')`;
  const apiList = apiProviders.length > 0 ? sql.join(apiProviders.map((p) => sql`${p}`), sql`, `) : sql`null`;
  const known = sql`${aiUsage.tokensIn} is not null`;
  const rows = await db
    .select({
      day,
      provider: aiUsage.provider,
      model: aiUsage.model,
      modelSource: aiUsage.modelSource,
      task: aiUsage.task,
      outcome: aiUsage.outcome,
      calls: sql<number>`count(*)::int`,
      tokenCalls: sql<number>`(count(*) filter (where ${known}))::int`,
      tokensIn: sql<string>`coalesce(sum(${aiUsage.tokensIn}), 0)`,
      tokensInCached: sql<string>`coalesce(sum(${aiUsage.tokensInCached}), 0)`,
      cachedCalls: sql<number>`(count(*) filter (where ${aiUsage.tokensInCached} is not null))::int`,
      reasoningCalls: sql<number>`(count(*) filter (where ${aiUsage.tokensOutReasoning} is not null))::int`,
      tokensInCacheWrite: sql<string>`coalesce(sum(${aiUsage.tokensInCacheWrite}), 0)`,
      tokensOut: sql<string>`coalesce(sum(${aiUsage.tokensOut}), 0)`,
      tokensOutReasoning: sql<string>`coalesce(sum(${aiUsage.tokensOutReasoning}), 0)`,
      durationMsSum: sql<string>`coalesce(sum(${aiUsage.durationMs}), 0)`,
      durationCalls: sql<number>`(count(*) filter (where ${aiUsage.durationMs} is not null))::int`,
      equivalentUsd: sql<string>`coalesce(sum(${aiUsage.equivalentCostUsd}), 0)`,
      equivalentCalls: sql<number>`(count(*) filter (where ${aiUsage.equivalentCostUsd} is not null))::int`,
      actualUsd: sql<string>`coalesce(sum(${aiUsage.costEstimate}) filter (where ${aiUsage.provider} not in (${apiList}) or ${known} or ${aiUsage.outcome} = 'failed'), 0)`,
      actualCalls: sql<number>`(count(*) filter (where ${aiUsage.provider} not in (${apiList}) or ${known} or ${aiUsage.outcome} = 'failed'))::int`,
      actualUsdWithEquivalent: sql<string>`coalesce(sum(${aiUsage.costEstimate}) filter (where ${aiUsage.equivalentCostUsd} is not null), 0)`,
    })
    .from(aiUsage)
    .where(window(filter))
    // by position: the day expression carries a bound time-zone parameter, which Postgres cannot match a second time
    .groupBy(sql`1, 2, 3, 4, 5, 6`);
  return rows.map((row) => ({
    day: row.day,
    provider: row.provider,
    model: row.model,
    modelSource: row.modelSource,
    task: row.task,
    outcome: row.outcome,
    calls: num(row.calls),
    tokenCalls: num(row.tokenCalls),
    tokensIn: num(row.tokensIn),
    tokensInCached: num(row.tokensInCached),
    cachedCalls: num(row.cachedCalls),
    reasoningCalls: num(row.reasoningCalls),
    tokensInCacheWrite: num(row.tokensInCacheWrite),
    tokensOut: num(row.tokensOut),
    tokensOutReasoning: num(row.tokensOutReasoning),
    durationMsSum: num(row.durationMsSum),
    durationCalls: num(row.durationCalls),
    equivalentUsd: num(row.equivalentUsd),
    equivalentCalls: num(row.equivalentCalls),
    actualUsd: num(row.actualUsd),
    actualCalls: num(row.actualCalls),
    actualUsdWithEquivalent: num(row.actualUsdWithEquivalent),
  }));
}

export interface AiUsageCall {
  id: number;
  at: Date;
  provider: string;
  model: string | null;
  modelSource: string | null;
  task: string;
  outcome: string | null;
  errorKind: string | null;
  tokensIn: number | null;
  tokensInCached: number | null;
  tokensInCacheWrite: number | null;
  tokensOut: number | null;
  tokensOutReasoning: number | null;
  durationMs: number | null;
  costUsd: number;
  equivalentUsd: number | null;
  job: { id: number; title: string; company: string | null } | null;
}

/** Newest first. */
export async function listAiUsageCalls(db: Db, filter: AiUsageFilter, page: { limit: number; offset: number }): Promise<AiUsageCall[]> {
  const rows = await db
    .select({
      id: aiUsage.id,
      at: aiUsage.at,
      provider: aiUsage.provider,
      model: aiUsage.model,
      modelSource: aiUsage.modelSource,
      task: aiUsage.task,
      outcome: aiUsage.outcome,
      errorKind: aiUsage.errorKind,
      tokensIn: aiUsage.tokensIn,
      tokensInCached: aiUsage.tokensInCached,
      tokensInCacheWrite: aiUsage.tokensInCacheWrite,
      tokensOut: aiUsage.tokensOut,
      tokensOutReasoning: aiUsage.tokensOutReasoning,
      durationMs: aiUsage.durationMs,
      costUsd: aiUsage.costEstimate,
      equivalentUsd: aiUsage.equivalentCostUsd,
      jobId: jobs.id,
      jobTitle: jobs.title,
      company: companies.name,
    })
    .from(aiUsage)
    .leftJoin(jobs, eq(jobs.id, aiUsage.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(window(filter))
    .orderBy(desc(aiUsage.at), desc(aiUsage.id))
    .limit(page.limit)
    .offset(page.offset);
  return rows.map(({ jobId, jobTitle, company, ...row }) => ({
    ...row,
    job: jobId !== null && jobTitle !== null ? { id: jobId, title: jobTitle, company } : null,
  }));
}

export async function countAiUsageCalls(db: Db, filter: AiUsageFilter): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(aiUsage).where(window(filter));
  return row?.n ?? 0;
}
