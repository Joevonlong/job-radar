import { monthKey } from "@/lib/channels/budget";
import { equivalentModelPrice, modelPrice, type ModelPrice, type ModelsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { insertAiUsage, sumAiCostForMonth } from "@/lib/db/repos/ai-usage";

import { AI_MODEL_SOURCES, AI_USAGE_OUTCOMES, type AiModelSource, type AiUsageOutcome } from "@/lib/ai-usage/constants";

import { AI_PROVIDER_IDS, AI_PROVIDER_KIND, type AiProviderId, type AiTask, type AiTokenUsage } from "./types";

export { AI_MODEL_SOURCES, AI_USAGE_OUTCOMES, type AiModelSource, type AiUsageOutcome };

export const API_PROVIDER_IDS: readonly AiProviderId[] = AI_PROVIDER_IDS.filter((id) => AI_PROVIDER_KIND[id] === "api");

/** USD, rounded to micro-dollars (ai_usage.cost_estimate has 6 decimals). */
export const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * Cost of `usage` at `price` (USD, micro-dollar precision). Uncached input is priced at `input_per_mtok`, cache reads at
 * `cached_input_per_mtok` and cache writes at `cache_write_per_mtok` (both default to the input price, which is how
 * calls were priced before AI usage tracking). Sub-counts larger than the input leave nothing for the uncached part (never negative).
 */
export function costOfUsage(price: ModelPrice, usage: AiTokenUsage): number {
  const cached = usage.cachedIn ?? 0;
  const written = usage.cacheWriteIn ?? 0;
  const plain = Math.max(0, usage.tokensIn - cached - written);
  const perMtok =
    plain * price.input_per_mtok +
    cached * (price.cached_input_per_mtok ?? price.input_per_mtok) +
    written * (price.cache_write_per_mtok ?? price.input_per_mtok) +
    usage.tokensOut * price.output_per_mtok;
  return roundUsd(perMtok / 1_000_000);
}

/**
 * Estimated cost of one call. Subscription CLIs cost 0 (their tokens are still recorded); API models are priced from
 * the catalog (`models.yaml`): by id, then by alias; a reported name the catalog does not know is priced at the
 * provider's highest price (`priced: "fallback"`) so the budget never leaks. No catalog or no priced model: 0 / "none".
 */
export function estimateCostUsd(
  catalog: ModelsConfig | null,
  provider: AiProviderId,
  model: string,
  usage: AiTokenUsage,
): { costUsd: number; priced: "exact" | "fallback" | "none" } {
  if (AI_PROVIDER_KIND[provider] === "cli") return { costUsd: 0, priced: "exact" };
  const found = catalog ? modelPrice(catalog, provider, model) : null;
  if (!found) return { costUsd: 0, priced: "none" };
  return { costUsd: costOfUsage(found.price, usage), priced: found.priced };
}

/**
 * What the same tokens would cost at API list prices; null = unknown. API providers: the actual cost (unknown
 * when the call had no price or the reply no usage). Subscription CLIs: `equivalent_price` of the model in the catalog;
 * no price or no usage = null (never invented).
 */
export function estimateEquivalentUsd(
  catalog: ModelsConfig | null,
  provider: AiProviderId,
  model: string,
  usage: AiTokenUsage,
  actual: { costUsd: number; priced: "exact" | "fallback" | "none" },
): number | null {
  if (usage.reported === false) return null;
  if (AI_PROVIDER_KIND[provider] === "api") return actual.priced === "none" ? null : actual.costUsd;
  const found = catalog && model !== "" ? equivalentModelPrice(catalog, provider, model) : null;
  return found ? costOfUsage(found.price, usage) : null;
}

/** `ai_usage.task` of the "test" button of a provider: kept apart from the real tasks. */
export const AI_PROBE_TASK = "probe";

export interface AiUsageEntry {
  provider: AiProviderId;
  task: AiTask | typeof AI_PROBE_TASK;
  model: string | null;
  modelSource: AiModelSource | null;
  /** null = the provider did not report it */
  tokensIn: number | null;
  tokensInCached: number | null;
  tokensInCacheWrite: number | null;
  tokensOut: number | null;
  tokensOutReasoning: number | null;
  durationMs: number | null;
  outcome: AiUsageOutcome;
  errorKind: string | null;
  /** actual spend (0 for subscriptions); what the monthly budget sums */
  costUsd: number;
  /** what the same tokens cost at API list prices; null = unknown */
  equivalentUsd: number | null;
  jobId: number | null;
  at: Date;
}

/** Where usage rows go and where the month's API spend is read from. */
export interface AiUsageStore {
  record(entry: AiUsageEntry): Promise<void>;
  /** Estimated spend of the paid API providers in `month` (`YYYY-MM` in `timeZone`). */
  apiSpendUsd(month: string, timeZone: string): Promise<number>;
}

export function createDbUsageStore(db: Db): AiUsageStore {
  return {
    record: (entry) =>
      insertAiUsage(db, {
        provider: entry.provider,
        task: entry.task,
        model: entry.model,
        modelSource: entry.modelSource,
        tokensIn: entry.tokensIn,
        tokensInCached: entry.tokensInCached,
        tokensInCacheWrite: entry.tokensInCacheWrite,
        tokensOut: entry.tokensOut,
        tokensOutReasoning: entry.tokensOutReasoning,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        errorKind: entry.errorKind,
        costEstimate: entry.costUsd,
        equivalentCostUsd: entry.equivalentUsd,
        jobId: entry.jobId,
        at: entry.at,
      }),
    apiSpendUsd: (month, timeZone) => sumAiCostForMonth(db, { month, timeZone, providers: API_PROVIDER_IDS }),
  };
}

/** In-memory store (tests, dry runs without a database). Spend is tracked per `YYYY-MM` key. */
export function createMemoryUsageStore(): AiUsageStore & { entries: AiUsageEntry[] } {
  const entries: AiUsageEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
    async apiSpendUsd(month, timeZone) {
      return roundUsd(
        entries
          .filter((e) => AI_PROVIDER_KIND[e.provider] === "api" && monthKey(e.at, timeZone) === month)
          .reduce((sum, e) => sum + e.costUsd, 0),
      );
    },
  };
}
