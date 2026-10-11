import type { InterestsConfig } from "@/lib/config/schemas/interests";
import type { HighValuePolicy } from "@/lib/db/queries/signal-filter";
import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";

import { buildCatalog } from "./catalog";

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A signal as the bonus sees it: its category and, for the amount category, `value_json`. A bare id has no amount (counts as high-pay). */
export type BonusSignal = string | { tier: string; value?: unknown };

export interface BonusPolicy {
  /** The amount category's id; null when there is none. */
  amountId: string | null;
  /** An amount counts when its annual upper bound in the base currency is at least this; null = every amount counts. */
  minAnnualEur: number | null;
  /** The market's base currency the minimum is in; null = unknown (no amount can be compared, all count); missing = EUR. */
  baseCurrency?: string | null;
  /** Base-currency units per unit for the comparison (the base itself is 1). Currencies missing here cannot be compared and count. */
  rates: Record<string, number>;
  /**
   * Points of the amount category when all its amounts are "possibly another region's pay" (its
   * `amount.other_region_weight`); 0 = such an amount brings no bonus and is not a high-pay signal.
   */
  otherRegionPoints: number;
}

/**
 * The amount rule of interests.yaml (`amount.bonus_requires_at_least` of the amount category) resolved against the
 * user's salary floor (preferences.yaml `salary_floor_year`; null = unknown, then `salary_floor` means "no minimum"), in
 * the market's base currency `baseCurrency` (the category's rough rates are per unit of it).
 */
export function bonusPolicy(config: Pick<InterestsConfig, "signals">, salaryFloor: number | null, baseCurrency: string | null = LEGACY_BASE_CURRENCY): BonusPolicy {
  const amount = buildCatalog(config).amount;
  const base = baseCurrency === null ? {} : { [baseCurrency]: 1 };
  if (!amount) return { amountId: null, minAnnualEur: null, baseCurrency, rates: base, otherRegionPoints: 0 };
  const rule = amount.amount.bonus_requires_at_least;
  const min = rule === "salary_floor" ? salaryFloor : rule === "none" ? null : rule;
  const rates: Record<string, number> = baseCurrency === null ? {} : { ...amount.amount.rough_fx, ...base };
  return { amountId: amount.id, minAnnualEur: min, baseCurrency, rates, otherRegionPoints: amount.amount.other_region_weight };
}

/** The high-value rule for the current categories: the bonus policy plus which categories are high value. */
export function highValuePolicy(config: Pick<InterestsConfig, "signals">, salaryFloor: number | null, baseCurrency: string | null = LEGACY_BASE_CURRENCY): HighValuePolicy {
  const catalog = buildCatalog(config);
  const policy = bonusPolicy(config, salaryFloor, baseCurrency);
  return {
    amountId: policy.amountId,
    amountHighValue: catalog.amount?.high_value ?? false,
    otherIds: catalog.highValueIds.filter((id) => id !== policy.amountId),
    minAnnualEur: policy.minAnnualEur,
    baseCurrency,
    rates: policy.rates,
    otherRegionPoints: policy.otherRegionPoints,
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The base-currency figures of a T1 value in `currency`: `basePerYear` of a value worked out in it, `eurPerYear` of an older value when the base is EUR. */
function baseFiguresOf(v: Record<string, unknown>, currency: string | null | undefined): Record<string, unknown> | null {
  if (currency === undefined) currency = LEGACY_BASE_CURRENCY;
  if (currency === null) return null;
  const legacy = v.baseCurrency === undefined || v.baseCurrency === null;
  const figures = legacy ? (currency === LEGACY_BASE_CURRENCY ? v.eurPerYear : null) : v.baseCurrency === currency ? v.basePerYear : null;
  return typeof figures === "object" && figures !== null ? (figures as Record<string, unknown>) : null;
}

/**
 * Annual upper bound (lower bound for "from X") of an amount value in the base currency; null when it cannot be told
 * (no base figure, and a currency without a rate).
 */
export function annualEurTop(value: unknown, policy: Pick<BonusPolicy, "rates" | "baseCurrency">): number | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const eur = baseFiguresOf(v, policy.baseCurrency);
  const eurTop = eur ? (numberOf(eur.max) ?? numberOf(eur.min)) : null;
  if (eurTop !== null) return eurTop;
  const top = numberOf(v.max) ?? numberOf(v.min) ?? numberOf(v.amount);
  const rate = typeof v.currency === "string" ? policy.rates[v.currency] : undefined;
  return top !== null && rate !== undefined ? top * rate : null;
}

/** Whether a stated amount (`value_json` of the amount category) reaches the high-pay minimum of `policy` (the salary floor). */
export function isHighPayAmount(value: unknown, policy: Pick<BonusPolicy, "minAnnualEur" | "rates" | "baseCurrency">): boolean {
  if (policy.minAnnualEur === null) return true;
  const top = annualEurTop(value, policy);
  return top === null || top >= policy.minAnnualEur;
}

/** Why an amount (`value_json`) is possibly another region's pay, or null. */
export function otherRegionOfAmount(value: unknown): "currency" | "description" | null {
  if (typeof value !== "object" || value === null) return null;
  const reason = (value as { otherRegion?: unknown }).otherRegion;
  return reason === "currency" || reason === "description" ? reason : null;
}

/**
 * Whether a stated amount is a high-pay signal: it reaches the minimum and is not another region's pay, unless
 * `other_region_weight` still gives such amounts points.
 */
export function isHighPaySignal(value: unknown, policy: Pick<BonusPolicy, "minAnnualEur" | "rates" | "baseCurrency" | "otherRegionPoints">): boolean {
  return isHighPayAmount(value, policy) && (otherRegionOfAmount(value) === null || policy.otherRegionPoints > 0);
}

/** Whether one stored signal makes its job high value (the JS twin of the SQL `hasHighValueSignal`). */
export function isHighValueSignal(signal: { tier: string; value?: unknown }, policy: HighValuePolicy): boolean {
  if (signal.tier === policy.amountId) return policy.amountHighValue && isHighPaySignal(signal.value, policy);
  return policy.otherIds.includes(signal.tier);
}

export interface BonusBreakdown {
  /** The categories that count, each once, with their points, in category order. */
  categories: Array<{ id: string; points: number }>;
  /** Σ of those points, before the cap. */
  sum: number;
  /** min(sum, cap): what is added to the match score. */
  bonus: number;
  capped: boolean;
  /** The job states an amount, but none reaches the threshold: it is shown muted and brings no points. */
  amountBelowThreshold: boolean;
  /** The threshold that was applied (per year in `baseCurrency`), null = none. */
  amountMinAnnualEur: number | null;
  /** The base currency the threshold is in (null = unknown). */
  baseCurrency: string | null;
  /** Every high-pay amount is possibly another region's pay: the amount category brings `otherRegionPoints` (maybe 0) instead of its weight. */
  amountOtherRegion: boolean;
}

const NO_MINIMUM: Omit<BonusPolicy, "amountId"> = { minAnnualEur: null, rates: { [LEGACY_BASE_CURRENCY]: 1 }, otherRegionPoints: 0 };

/**
 * Signal bonus of a job: the weights of the active categories it has signals of (a category counts once), capped
 *. A stated amount only counts when it is high-pay under `policy` (default: every amount counts);
 * when every such amount is possibly another region's pay, the amount category brings `policy.otherRegionPoints`
 * instead. Retired and unknown categories bring nothing; tag categories only count with a weight above 0.
 */
export function signalBonus(signals: Iterable<BonusSignal>, config: Pick<InterestsConfig, "signals" | "bonus_cap">, policy: Omit<BonusPolicy, "amountId"> = NO_MINIMUM): BonusBreakdown {
  const catalog = buildCatalog(config);
  const amountId = catalog.amount?.id ?? null;
  const present = new Set<string>();
  let amountSeen = false;
  let amountOtherRegion = false;
  for (const signal of signals) {
    const id = typeof signal === "string" ? signal : signal.tier;
    const category = catalog.byId.get(id);
    if (!category) continue;
    if (category.kind === "tag" && category.weight <= 0) continue;
    if (id === amountId) {
      amountSeen = true;
      if (typeof signal !== "string") {
        if (!isHighPayAmount(signal.value, policy)) continue;
        if (otherRegionOfAmount(signal.value) !== null) {
          amountOtherRegion = true;
          continue;
        }
      }
    }
    present.add(id);
  }
  // a local amount wins; only other regions' amounts: their (reduced) points, none at 0
  const otherRegionOnly = amountId !== null && amountOtherRegion && !present.has(amountId);
  if (otherRegionOnly && policy.otherRegionPoints > 0 && amountId !== null) present.add(amountId);
  const list = catalog.categories
    .filter((category) => present.has(category.id))
    .map((category) => ({ id: category.id, points: category.id === amountId && otherRegionOnly ? policy.otherRegionPoints : category.weight }));
  const sum = round2(list.reduce((total, entry) => total + entry.points, 0));
  const bonus = round2(Math.min(sum, config.bonus_cap));
  return {
    categories: list,
    sum,
    bonus,
    capped: sum > config.bonus_cap,
    amountBelowThreshold: amountSeen && amountId !== null && !present.has(amountId) && !otherRegionOnly,
    amountMinAnnualEur: policy.minAnnualEur,
    baseCurrency: policy.baseCurrency === undefined ? LEGACY_BASE_CURRENCY : policy.baseCurrency,
    amountOtherRegion: otherRegionOnly,
  };
}
