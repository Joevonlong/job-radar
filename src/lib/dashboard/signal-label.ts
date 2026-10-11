import { z } from "zod";

import type { Locale } from "@/i18n/locale";
import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";
import { formatSalary, salaryKDecimals, type SalaryPeriod } from "@/lib/format/numbers";

const amountValueSchema = z.object({
  min: z.number().finite().nullish(),
  max: z.number().finite().nullish(),
  amount: z.number().finite().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
});

function currencySymbol(currency: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * 85000 → "85k", 1200000 → "1200k", 950 → "950": a short amount for a badge, the same in every UI language. `decimals` is
 * the one the whole figure gets from `salaryKDecimals` (whole k, except a range narrower than 10k).
 */
function shortAmount(value: number, decimals: 0 | 1 = 1): string {
  if (Math.abs(value) < 1000) return String(Math.round(value));
  const scale = decimals === 0 ? 1 : 10;
  return `${Math.round((value / 1000) * scale) / scale}k`;
}

/**
 * Short amount text for a T1 signal ("€85–105k", "≤ €120k") from its `value_json`, or null when the
 * value carries no readable amount (the badge then shows the tier label instead; nothing is guessed, C3).
 * `approx` (a converted figure, `isApproxAnnual`): whole k and a leading "≈ ", like `formatSalary` writes it.
 */
export function signalAmountLabel(value: unknown, locale: string, options: { approx?: boolean } = {}): string | null {
  const parsed = amountValueSchema.safeParse(value);
  if (!parsed.success) return null;
  const { min, max, amount, currency } = parsed.data;
  const approx = options.approx === true;
  const symbol = currency ? currencySymbol(currency, locale) : "";
  const hasMin = min !== null && min !== undefined;
  const hasMax = max !== null && max !== undefined;
  // a converted figure is an estimate: whole k, "≈ " in front (a decimal would claim a precision it does not have)
  const lead = approx ? "≈ " : "";
  const single: 0 | 1 = approx ? 0 : 1;

  if (amount !== null && amount !== undefined) return `${lead}${symbol}${shortAmount(amount, single)}`;
  if (hasMin && hasMax) {
    if (min === max) return `${lead}${symbol}${shortAmount(min, single)}`;
    // "€85–105k": the symbol and the k only once when both ends share the unit
    const decimals = approx ? 0 : salaryKDecimals(min, max);
    const lowShort = shortAmount(min, decimals);
    const highShort = shortAmount(max, decimals);
    return lowShort.endsWith("k") && highShort.endsWith("k") ? `${lead}${symbol}${lowShort.slice(0, -1)}–${highShort}` : `${lead}${symbol}${lowShort}–${symbol}${highShort}`;
  }
  if (hasMax) return `${lead}≤ ${symbol}${shortAmount(max, single)}`;
  if (hasMin) return `${lead}≥ ${symbol}${shortAmount(min, single)}`;
  return null;
}

/** The normalized (per year) amount of a T1 signal as the detail page shows it, in `formatSalary`'s format: "€85–105k /年", "最高 €120k /年". */
export interface SignalAmountText {
  /** Per-year figure, e.g. "€85–105k /年". */
  normalized: string;
  /** What the JD states when that differs from the per-year figure (a monthly salary, ...), e.g. "€7.2k /月"; null otherwise. */
  stated: string | null;
  statedPeriod: "year" | "month" | "week" | "day" | "hour";
  periodAssumed: boolean;
  currencyAssumed: boolean;
  /** The figure in the base currency, when it is not in it but a rate was configured: "≈ €139–163k /年". */
  eurApprox: string | null;
}

/** Lenient on purpose: values written by the dev seed or by older code lack the fields added later. */
const statedAmountSchema = z.object({
  min: z.number().finite().nullish(),
  max: z.number().finite().nullish(),
  amount: z.number().finite().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  eurPerYear: z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish() }).nullish(),
  basePerYear: z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish() }).nullish(),
  baseCurrency: z.string().nullish(),
  stated: z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish(), period: z.enum(["year", "month", "week", "day", "hour"]) }).nullish(),
  periodAssumed: z.boolean().default(false),
  currencyAssumed: z.boolean().default(false),
});

/** `formatSalary` for one amount or range of `currency`; "" when no bound is known. */
function rangeText(min: number | null | undefined, max: number | null | undefined, currency: string, locale: Locale, period: SalaryPeriod, approx = false): string {
  return formatSalary({ min, max, currency, approx }, { locale, period }) ?? "";
}

/** Readable amount of a T1 signal (`signals.value_json`), or null when the stored value is not a T1 amount. */
export function signalAmountText(value: unknown, locale: Locale): SignalAmountText | null {
  const parsed = statedAmountSchema.safeParse(value);
  if (!parsed.success) return null;
  const { min, max, amount, currency, eurPerYear, basePerYear, baseCurrency, stated, periodAssumed, currencyAssumed } = parsed.data;
  // The base-currency figure; a value stored before has its EUR figure
  const base = baseCurrency ? { range: basePerYear, currency: baseCurrency } : { range: eurPerYear, currency: LEGACY_BASE_CURRENCY };
  // a per-year figure computed from a monthly / weekly / daily / hourly one is an estimate: "≈ €86k /年", whole k
  const converted = stated != null && stated.period !== "year";
  const normalized = amount != null ? rangeText(amount, amount, currency, locale, "year", converted) : rangeText(min, max, currency, locale, "year", converted);
  if (normalized === "") return null;
  return {
    normalized,
    stated: !stated || stated.period === "year" ? null : rangeText(stated.min, stated.max, currency, locale, stated.period),
    statedPeriod: stated?.period ?? "year",
    periodAssumed,
    currencyAssumed,
    eurApprox: currency !== base.currency && base.range ? rangeText(base.range.min, base.range.max, base.currency, locale, "year", true) || null : null,
  };
}
