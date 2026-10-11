/** View model of /sources/ai-usage: pure functions from the SQL groups to the numbers the page shows. */
import { eachDay } from "@/lib/insights/range";
import type { AiUsageGroup } from "@/lib/db/queries/ai-usage";

import type { ResolvedRange } from "./range";

export interface AiUsageFilterState {
  provider?: string | undefined;
  model?: string | undefined;
  task?: string | undefined;
}

export interface AiUsageTotals {
  calls: number;
  ok: number;
  invalid: number;
  failed: number;
  /** written before AI usage tracking: no outcome */
  legacy: number;
  tokenCalls: number;
  /** calls without token counts (the provider did not report them) */
  tokenUnknownCalls: number;
  tokensIn: number;
  tokensInCached: number;
  /** token-reporting calls whose cached-input count is unknown (old rows): the cached sum covers only the others */
  cachedUnknownCalls: number;
  tokensInCacheWrite: number;
  tokensOut: number;
  tokensOutReasoning: number;
  /** token-reporting calls whose reasoning-output count is unknown */
  reasoningUnknownCalls: number;
  equivalentUsd: number;
  /** calls without an equivalent cost (no equivalent price, no token counts, or failed) */
  equivalentUnknownCalls: number;
  /** of those, calls whose model is unknown (no model recorded): not a catalog gap */
  equivalentUnknownModelCalls: number;
  actualUsd: number;
  actualUnknownCalls: number;
  /** equivalent - actual, over the calls that have an equivalent cost */
  savingsUsd: number;
  avgDurationMs: number | null;
}

export interface AiUsageBreakdownRow extends AiUsageTotals {
  key: string;
  provider: string | null;
  model: string | null;
  modelLabel: string | null;
  modelSource: string | null;
  task: string | null;
  /** equivalentUsd as a percentage of the table's total (0..100); null when that total is 0 */
  share: number | null;
  /** what a click on the row filters by; null = not clickable (unknown model) */
  filter: AiUsageFilterState | null;
}

export interface AiUsageDayColumn {
  day: string;
  byProvider: Record<string, { calls: number; tokens: number; equivalentUsd: number }>;
}

export interface AiUsageView {
  range: ResolvedRange;
  filter: AiUsageFilterState;
  totals: AiUsageTotals;
  byModel: AiUsageBreakdownRow[];
  byProvider: AiUsageBreakdownRow[];
  byTask: AiUsageBreakdownRow[];
  days: AiUsageDayColumn[];
  /** subscription models with calls but no equivalent price (for the footnote) */
  missingEquivalentModels: { provider: string; model: string }[];
  empty: boolean;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function totalsOf(groups: readonly AiUsageGroup[]): AiUsageTotals {
  const t = {
    calls: 0, ok: 0, invalid: 0, failed: 0, legacy: 0, tokenCalls: 0, tokensIn: 0, tokensInCached: 0, tokensInCacheWrite: 0, tokensOut: 0, tokensOutReasoning: 0, cachedCalls: 0, reasoningCalls: 0, equivalentUnknownModelCalls: 0,
    equivalentUsd: 0, equivalentCalls: 0, actualUsd: 0, actualCalls: 0, actualUsdWithEquivalent: 0, durationMsSum: 0, durationCalls: 0,
  };
  for (const g of groups) {
    t.calls += g.calls;
    if (g.outcome === "ok") t.ok += g.calls;
    else if (g.outcome === "invalid_output") t.invalid += g.calls;
    else if (g.outcome === "failed") t.failed += g.calls;
    else t.legacy += g.calls;
    t.tokenCalls += g.tokenCalls;
    t.tokensIn += g.tokensIn;
    t.tokensInCached += g.tokensInCached;
    t.tokensInCacheWrite += g.tokensInCacheWrite;
    t.tokensOut += g.tokensOut;
    t.tokensOutReasoning += g.tokensOutReasoning;
    t.cachedCalls += g.cachedCalls;
    t.reasoningCalls += g.reasoningCalls;
    if (g.model === null) t.equivalentUnknownModelCalls += g.calls - g.equivalentCalls;
    t.equivalentUsd += g.equivalentUsd;
    t.equivalentCalls += g.equivalentCalls;
    t.actualUsd += g.actualUsd;
    t.actualCalls += g.actualCalls;
    t.actualUsdWithEquivalent += g.actualUsdWithEquivalent;
    t.durationMsSum += g.durationMsSum;
    t.durationCalls += g.durationCalls;
  }
  return {
    calls: t.calls,
    ok: t.ok,
    invalid: t.invalid,
    failed: t.failed,
    legacy: t.legacy,
    tokenCalls: t.tokenCalls,
    tokenUnknownCalls: t.calls - t.tokenCalls,
    tokensIn: t.tokensIn,
    tokensInCached: t.tokensInCached,
    cachedUnknownCalls: Math.max(0, t.tokenCalls - t.cachedCalls),
    tokensInCacheWrite: t.tokensInCacheWrite,
    tokensOut: t.tokensOut,
    tokensOutReasoning: t.tokensOutReasoning,
    reasoningUnknownCalls: Math.max(0, t.tokenCalls - t.reasoningCalls),
    equivalentUsd: round6(t.equivalentUsd),
    equivalentUnknownCalls: t.calls - t.equivalentCalls,
    equivalentUnknownModelCalls: t.equivalentUnknownModelCalls,
    actualUsd: round6(t.actualUsd),
    actualUnknownCalls: t.calls - t.actualCalls,
    savingsUsd: round6(t.equivalentUsd - t.actualUsdWithEquivalent),
    avgDurationMs: t.durationCalls > 0 ? t.durationMsSum / t.durationCalls : null,
  };
}

const SOURCE_PRIORITY = ["assumed", "cli_default", "call"] as const;

function pickSource(groups: readonly AiUsageGroup[]): string | null {
  for (const source of SOURCE_PRIORITY) if (groups.some((g) => g.modelSource === source)) return source;
  return null;
}

function bucket(groups: readonly AiUsageGroup[], keyOf: (g: AiUsageGroup) => string): Map<string, AiUsageGroup[]> {
  const map = new Map<string, AiUsageGroup[]>();
  for (const g of groups) {
    const key = keyOf(g);
    const list = map.get(key);
    if (list) list.push(g);
    else map.set(key, [g]);
  }
  return map;
}

/** Most expensive (equivalent) first, then most calls, then key: stable for tests. */
function finish(rows: AiUsageBreakdownRow[]): AiUsageBreakdownRow[] {
  const total = rows.reduce((sum, row) => sum + row.equivalentUsd, 0);
  return rows
    .map((row) => ({ ...row, share: total > 0 ? (row.equivalentUsd / total) * 100 : null }))
    .sort((a, b) => b.equivalentUsd - a.equivalentUsd || b.calls - a.calls || a.key.localeCompare(b.key));
}

export interface BuildViewInput {
  groups: readonly AiUsageGroup[];
  range: ResolvedRange;
  filter: AiUsageFilterState;
  /** display name of a catalog model, null when the catalog does not know it */
  labels: (provider: string, model: string) => string | null;
  isSubscription: (provider: string) => boolean;
}

export function buildAiUsageView(input: BuildViewInput): AiUsageView {
  const { groups, range, filter } = input;
  const totals = totalsOf(groups);
  const blank = { provider: null, model: null, modelLabel: null, modelSource: null, task: null, share: null, filter: null };

  const byModel = finish(
    [...bucket(groups, (g) => `${g.provider}|${g.model ?? "∅"}`)].map(([key, list]) => {
      const first = list[0] as AiUsageGroup;
      return {
        ...totalsOf(list),
        ...blank,
        key,
        provider: first.provider,
        model: first.model,
        modelLabel: first.model === null ? null : input.labels(first.provider, first.model),
        modelSource: first.model === null ? null : pickSource(list),
        filter: first.model === null ? null : { provider: first.provider, model: first.model },
      };
    }),
  );
  const byProvider = finish(
    [...bucket(groups, (g) => g.provider)].map(([key, list]) => ({ ...totalsOf(list), ...blank, key, provider: key, filter: { provider: key } })),
  );
  const byTask = finish(
    [...bucket(groups, (g) => g.task)].map(([key, list]) => ({ ...totalsOf(list), ...blank, key, task: key, filter: { task: key } })),
  );

  const perDay = bucket(groups, (g) => g.day);
  const days = eachDay(range.from, range.to).map((day): AiUsageDayColumn => {
    const byProviderOfDay: AiUsageDayColumn["byProvider"] = {};
    for (const g of perDay.get(day) ?? []) {
      const slot = (byProviderOfDay[g.provider] ??= { calls: 0, tokens: 0, equivalentUsd: 0 });
      slot.calls += g.calls;
      slot.tokens += g.tokensIn + g.tokensOut;
      slot.equivalentUsd = round6(slot.equivalentUsd + g.equivalentUsd);
    }
    return { day, byProvider: byProviderOfDay };
  });

  const missingEquivalentModels: AiUsageView["missingEquivalentModels"] = [];
  for (const [, list] of bucket(groups.filter((g) => g.model !== null && g.outcome !== "failed" && input.isSubscription(g.provider)), (g) => `${g.provider}|${g.model}`)) {
    const first = list[0] as AiUsageGroup;
    const withTokens = list.reduce((sum, g) => sum + g.tokenCalls, 0);
    const priced = list.reduce((sum, g) => sum + g.equivalentCalls, 0);
    if (withTokens > 0 && priced === 0 && first.model !== null) missingEquivalentModels.push({ provider: first.provider, model: first.model });
  }
  missingEquivalentModels.sort((a, b) => `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`));

  return { range, filter, totals, byModel, byProvider, byTask, days, missingEquivalentModels, empty: totals.calls === 0 };
}
