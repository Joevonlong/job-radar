import { and, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { aiUsage } from "../schema";

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
