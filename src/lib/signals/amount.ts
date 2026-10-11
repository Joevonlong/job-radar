import type { PipelineConfig } from "@/lib/config";
import { buildSalary, parseSalaryText } from "@/lib/pipeline/salary";

import type { SalaryPeriod, SignalAmount } from "./types";

export interface AmountOptions {
  /** Annual figures below this much in the base currency are not a salary (the amount category's `amount.min_annual`). */
  minAnnualEur: number;
  /** Currency to use when the text names none and a salary word is near (the amount category's `amount.assume_currency`); null: such amounts are dropped. */
  assumeCurrency: string | null;
  /** A salary word (pipeline.yaml `salary.description_context_patterns`) is in the sentence. */
  salaryContext: boolean;
  /** The whole JD, for the "possibly another region's pay" mark (pipeline.yaml `salary.other_region_patterns`). */
  description?: string | null;
}

export interface StatedAmount {
  min: number | null;
  max: number | null;
  period: SalaryPeriod | null;
  currency: string | null;
  periodAssumed: boolean;
}

/**
 * Stated figures → the normalized amount value: per-year amounts, EUR per year when convertible, and
 * the verdict "is this a plausible salary" (known period, plausible size, at least `minAnnualEur`).
 * Null when it is not. Nothing is guessed: a missing period is only filled in by the pipeline's
 * "too big to be anything but annual" rule, a missing currency only by `assumeCurrency` next to a salary word.
 */
export function normalizeAmount(stated: StatedAmount, pipeline: PipelineConfig, options: AmountOptions, raw = ""): SignalAmount | null {
  let { currency } = stated;
  let currencyAssumed = false;
  if (currency === null) {
    if (options.assumeCurrency === null || !options.salaryContext) return null;
    // `market` = the market's base currency
    currency = options.assumeCurrency === "market" ? pipeline.market.currency : options.assumeCurrency;
    currencyAssumed = true;
  }
  if (stated.period === null) return null;
  const salary = buildSalary(
    { raw, currency, period: stated.period, min: stated.min, max: stated.max, periodAssumed: stated.periodAssumed, origin: "description" },
    pipeline,
    { description: options.description ?? null },
  );
  if (salary.qualityStatus !== "valid" || salary.perYear === null) return null;
  const comparable = salary.basePerYear ?? salary.perYear;
  const top = Math.max(comparable.min ?? 0, comparable.max ?? 0);
  if (top < options.minAnnualEur) return null;
  if (salary.perYear.min === null && salary.perYear.max === null) return null;
  return {
    currency,
    min: salary.perYear.min,
    max: salary.perYear.max,
    eurPerYear: salary.eurPerYear,
    basePerYear: salary.basePerYear,
    baseCurrency: salary.baseCurrency,
    stated: { min: stated.min, max: stated.max, period: stated.period },
    periodAssumed: stated.periodAssumed,
    currencyAssumed,
    ...(salary.otherRegion ? { otherRegion: salary.otherRegion } : {}),
  };
}

/**
 * A stored amount worked out again from what the JD states (`stated`, currency, period) with the
 * current pipeline.yaml: per-year figures, base-currency figures and the "another region's pay" mark follow
 * `salary.periods_per_year`, `salary.fx_rates`, the market's currency, `salary.local_currencies` and `salary.other_region_patterns`.
 * Everything else (assumed currency or period, salary origin) stays. The amount itself is never dropped here.
 */
export function revalueAmount(value: SignalAmount, pipeline: PipelineConfig, description: string | null): SignalAmount {
  const salary = buildSalary(
    { raw: "", currency: value.currency, period: value.stated.period, min: value.stated.min, max: value.stated.max, periodAssumed: value.periodAssumed, origin: "description" },
    pipeline,
    { description },
  );
  if (salary.perYear === null) return value;
  const { otherRegion: _previous, ...rest } = value;
  void _previous;
  return {
    ...rest,
    min: salary.perYear.min,
    max: salary.perYear.max,
    eurPerYear: salary.eurPerYear,
    basePerYear: salary.basePerYear,
    baseCurrency: salary.baseCurrency,
    ...(salary.otherRegion ? { otherRegion: salary.otherRegion } : {}),
  };
}

/** A word that makes an amount a one-sided bound or names its period, right before the amount. */
const BOUND_WORD = /(?<![\p{L}])(?:up\s*to|bis\s+zu|bis|from|ab|mindestens|minimum|min\.?|max(?:imum|imal)?\.?|höchstens)\s*$/iu;
const LOOKBEHIND_CHARS = 30;

/**
 * Read the amount of an amount-category hit. `before` / `after` are the JD text around the hit on the same line.
 * The text since the last digit before the hit ("Monthly gross salary: ", "up to ") and the text up
 * to the next digit after it ("per year", "monthly") are used: that is where bounds and periods are
 * named, and a neighbouring number can never become part of the range.
 */
export function parseHitAmount(hit: string, before: string, after: string, pipeline: PipelineConfig, options: AmountOptions): SignalAmount | null {
  const lastDigit = before.search(/\d(?!.*\d)/u);
  const sinceDigit = lastDigit === -1 ? before : before.slice(lastDigit + 1);
  const prefix = sinceDigit.slice(-LOOKBEHIND_CHARS);
  const firstDigit = after.search(/\d/u);
  const suffix = (firstDigit === -1 ? after : after.slice(0, firstDigit)).slice(0, 45);
  // "$184,050 $262,928": two amounts side by side are a range
  const joined = hit.replace(/(\d)\s+((?:€|EUR|USD|\$|£|GBP|CHF)\s?\d)/giu, "$1 - $2");
  const text = `${BOUND_WORD.test(before.slice(-16)) || prefix.trim() !== "" ? prefix : ""}${joined}${suffix}`;
  const parsed = parseSalaryText(text, pipeline, { requireCurrency: false });
  if (!parsed) return null;
  return normalizeAmount(parsed, pipeline, options, text);
}
