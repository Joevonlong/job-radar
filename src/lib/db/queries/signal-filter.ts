import { and, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { jobs, signals } from "../schema";
import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";

/**
 * What makes a job "high value" (the "high-value signals only" quick filter, the lower push threshold, the
 * "qualified" count of Today, the statistics, saved view trends): a signal of a category with `high_value` in
 * interests.yaml. A signal of the amount category only counts when the amount reaches the minimum (the salary floor by
 * default) and is local pay, unless amounts of other regions still get points. The same numbers as the bonus
 * (`@/lib/signals` `highValuePolicy`), so a list and the push agree. Built by `loadHighValuePolicy`.
 */
export interface HighValuePolicy {
  /** The amount category's id, null when there is none. */
  amountId: string | null;
  /** The amount category has `high_value`. */
  amountHighValue: boolean;
  /** The other high-value categories: any signal of them counts. */
  otherIds: readonly string[];
  /** An amount counts when its annual upper bound in the base currency is at least this; null = every amount counts. */
  minAnnualEur: number | null;
  /** The market's base currency the minimum is in; null = no amount can be compared. Missing = EUR (older callers). */
  baseCurrency?: string | null;
  /** Base-currency units per unit for that comparison (the base itself is 1); a currency without a rate cannot be compared and counts. */
  rates: Readonly<Record<string, number>>;
  /** The amount category's `other_region_weight`: 0 = an amount marked "possibly another region's pay" does not count. */
  otherRegionPoints: number;
}

/** The base currency of a policy: its own (null = none: nothing compares), EUR for a policy from before the market packs or none at all. */
export function policyCurrency(policy?: { baseCurrency?: string | null }): string {
  if (policy === undefined || policy.baseCurrency === undefined) return LEGACY_BASE_CURRENCY;
  return policy.baseCurrency ?? "";
}

/** Whether any category is high value (otherwise the quick filter is hidden and the push uses one threshold). */
export function hasHighValueCategories(policy: HighValuePolicy | null | undefined): policy is HighValuePolicy {
  return policy != null && ((policy.amountHighValue && policy.amountId !== null) || policy.otherIds.length > 0);
}

/** SQL: the signal row's amount reaches the minimum (or cannot be compared) and, unless such amounts still get points, is local pay. */
function amountQualifies(policy: HighValuePolicy): SQL {
  const value = signals.valueJson;
  const local = policy.otherRegionPoints > 0 ? sql`true` : sql`(${value} ->> 'otherRegion') is null`;
  if (policy.minAnnualEur === null) return local;
  // The figure in the base currency (an older value's EUR figure is that when the base is EUR); a value worked
  // out in another base currency (before the currency changed) has none here
  const figures = sql`(case when coalesce(${value} ->> 'baseCurrency', ${LEGACY_BASE_CURRENCY}) = ${policyCurrency(policy)} then coalesce(${value} -> 'basePerYear', ${value} -> 'eurPerYear') end)`;
  const top = sql`coalesce(
    (${figures} ->> 'max')::numeric,
    (${figures} ->> 'min')::numeric,
    coalesce((${value} ->> 'max')::numeric, (${value} ->> 'min')::numeric, (${value} ->> 'amount')::numeric)
      * (${JSON.stringify(policy.rates)}::jsonb ->> (${value} ->> 'currency'))::numeric
  )`;
  return sql`(${local} and (${top} is null or ${top} >= ${policy.minAnnualEur}))`;
}

/**
 * Condition: the job has a high-value signal under `policy` (false when no category is high value). Used by the Today
 * and Jobs lists, the cycle summaries, the statistics and the saved view trends.
 */
export function hasHighValueSignal(db: Db, policy: HighValuePolicy): SQL {
  const parts: SQL[] = [];
  if (policy.amountHighValue && policy.amountId !== null) {
    const amount = and(eq(signals.tier, policy.amountId), amountQualifies(policy));
    if (amount) parts.push(amount);
  }
  if (policy.otherIds.length > 0) parts.push(inArray(signals.tier, [...policy.otherIds]));
  const wanted = parts.length === 1 ? parts[0] : or(...parts);
  if (!wanted) return sql`false`;
  return exists(
    db
      .select({ jobId: signals.jobId })
      .from(signals)
      .where(and(eq(signals.jobId, jobs.id), wanted)),
  );
}
