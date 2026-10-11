import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { aiUsage, cycles } from "../schema";

/** A row to write; `null` token fields mean "the provider did not report it" (never 0). */
export interface AiUsageInsert {
  provider: string;
  task: string;
  model?: string | null;
  modelSource?: string | null;
  tokensIn: number | null;
  tokensInCached?: number | null;
  tokensInCacheWrite?: number | null;
  tokensOut: number | null;
  tokensOutReasoning?: number | null;
  durationMs?: number | null;
  outcome?: string | null;
  errorKind?: string | null;
  costEstimate: number;
  equivalentCostUsd?: number | null;
  jobId?: number | null;
  at?: Date;
}

export async function insertAiUsage(db: Db, row: AiUsageInsert): Promise<void> {
  await db.insert(aiUsage).values({
    provider: row.provider,
    task: row.task,
    model: row.model ?? null,
    modelSource: row.modelSource ?? null,
    tokensIn: row.tokensIn,
    tokensInCached: row.tokensInCached ?? null,
    tokensInCacheWrite: row.tokensInCacheWrite ?? null,
    tokensOut: row.tokensOut,
    tokensOutReasoning: row.tokensOutReasoning ?? null,
    durationMs: row.durationMs ?? null,
    outcome: row.outcome ?? null,
    errorKind: row.errorKind ?? null,
    costEstimate: row.costEstimate,
    equivalentCostUsd: row.equivalentCostUsd ?? null,
    jobId: row.jobId ?? null,
    ...(row.at ? { at: row.at } : {}),
  });
}

/**
 * Estimated spend (USD) of `providers` in the calendar month `month` (`YYYY-MM`) of `timeZone`.
 * The month is evaluated in SQL so it matches the timezone the budgets are counted in.
 */
export async function sumAiCostForMonth(db: Db, args: { month: string; timeZone: string; providers: readonly string[] }): Promise<number> {
  if (args.providers.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsage.costEstimate}), 0)` })
    .from(aiUsage)
    .where(
      and(
        inArray(aiUsage.provider, [...args.providers]),
        sql`to_char(${aiUsage.at} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`,
      ),
    );
  return Number(row?.total ?? 0);
}

/** When each call of `provider` since `since` (inclusive) happened, oldest first (failed calls included): the usage cap's window. */
export async function listAiUsageTimesSince(db: Db, args: { provider: string; since: Date }): Promise<Date[]> {
  const rows = await db
    .select({ at: aiUsage.at })
    .from(aiUsage)
    .where(and(eq(aiUsage.provider, args.provider), gte(aiUsage.at, args.since)))
    .orderBy(asc(aiUsage.at));
  return rows.map((row) => row.at);
}

/** How many calls `provider` made since `since` (inclusive), failed ones included: the usage cap's per-cycle count. */
export async function countAiUsageSince(db: Db, args: { provider: string; since: Date }): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(aiUsage)
    .where(and(eq(aiUsage.provider, args.provider), gte(aiUsage.at, args.since)));
  return Number(row?.n ?? 0);
}

/** p50 / p95 / max of a distribution of call counts; null when there is nothing to measure. */
export interface CallCountStats {
  /** How many windows / cycles were measured. */
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface AiUsageStats {
  provider: string;
  calls: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Calls inside the `windowHours` before each call (a rolling window ending at every call). */
  window: CallCountStats;
  /** Calls per processing cycle: every call belongs to the latest cycle that started before it (an upper bound: calls between cycles count too). */
  cycle: CallCountStats;
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asDate = (value: unknown): Date | null => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));

/**
 * Read-only statistics of the calls of `providers`, for choosing the defaults of ai.yaml `quota_guard`: the calls in a
 * rolling `windowHours` window and the calls per cycle (p50 / p95 / max). Only SELECTs.
 */
export async function aiUsageStats(db: Db, args: { providers: readonly string[]; windowHours: number }): Promise<AiUsageStats[]> {
  if (args.providers.length === 0) return [];
  const providers = [...args.providers];
  const hours = Math.max(1, Math.round(args.windowHours));
  const list = sql.join(providers.map((p) => sql`${p}`), sql`, `);
  const windows = await db.execute<Record<string, unknown>>(sql`
    with w as (
      select provider, at,
        count(*) over (partition by provider order by at range between make_interval(hours => ${hours}) preceding and current row) as n
      from ${aiUsage}
      where provider in (${list})
    )
    select provider, count(*) as samples, min(at) as first_at, max(at) as last_at,
      percentile_cont(0.5) within group (order by n) as p50,
      percentile_cont(0.95) within group (order by n) as p95,
      max(n) as max
    from w group by provider
  `);
  const cycleRows = await db.execute<Record<string, unknown>>(sql`
    with c as (
      select id, started_at, lead(started_at) over (order by started_at) as next_at from ${cycles}
    ), per as (
      select c.id, u.provider, count(*) as n
      from c join ${aiUsage} u on u.at >= c.started_at and (c.next_at is null or u.at < c.next_at)
      where u.provider in (${list})
      group by c.id, u.provider
    )
    select provider, count(*) as samples,
      percentile_cont(0.5) within group (order by n) as p50,
      percentile_cont(0.95) within group (order by n) as p95,
      max(n) as max
    from per group by provider
  `);
  const empty: CallCountStats = { samples: 0, p50: null, p95: null, max: null };
  const statsOf = (row: Record<string, unknown> | undefined): CallCountStats =>
    row ? { samples: Number(row.samples ?? 0), p50: num(row.p50), p95: num(row.p95), max: num(row.max) } : empty;
  return providers.map((provider) => {
    const w = [...windows].find((row) => row.provider === provider);
    const c = [...cycleRows].find((row) => row.provider === provider);
    return { provider, calls: Number(w?.samples ?? 0), firstAt: asDate(w?.first_at), lastAt: asDate(w?.last_at), window: statsOf(w), cycle: statsOf(c) };
  });
}
