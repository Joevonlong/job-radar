import { z } from "zod";

import { SALARY_PERIODS } from "@/lib/channels/types";
import { OTHER_REGION_REASONS } from "@/lib/domain/types";

export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

/** A signal category id (interests.yaml `signals.categories[].id`), stored in `signals.tier` (was the tier T1-T4 / tag). */
export type SignalCategoryId = string;

const range = z.object({ min: z.number().nullable(), max: z.number().nullable() });

/**
 * `signals.value_json` of a signal of the amount category. `min` / `max` are PER YEAR in `currency` (that is what the
 * badge shows); `stated` keeps the figures and period exactly as the JD gives them.
 */
export const signalAmountSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** Only when the currency is EUR or pipeline.yaml has a rate for it (written while the base currency is EUR). */
  eurPerYear: range.nullable(),
  /** Per year in the market's base currency `baseCurrency` (when the currency is it or has a rate); older values lack both. */
  basePerYear: range.nullish(),
  baseCurrency: z.string().nullish(),
  stated: z.object({ min: z.number().nullable(), max: z.number().nullable(), period: z.enum(SALARY_PERIODS) }),
  /** The JD names no period; read as annual because the amount is too large for anything else. */
  periodAssumed: z.boolean(),
  /** The JD names no currency; the amount category's `amount.assume_currency` was applied. */
  currencyAssumed: z.boolean(),
  /** Taken from the job's normalized salary (`jobs.salary_json`), not from a JD pattern: it follows the salary when that changes. */
  fromSalary: z.boolean().optional(),
  /** Possibly another region's pay: a non-local currency, or the JD says the range is for another location. */
  otherRegion: z.enum(OTHER_REGION_REASONS).optional(),
});
export type SignalAmount = z.infer<typeof signalAmountSchema>;

/** `signals.kind` of an amount signal, from the shape of the amount. */
export function amountKind(amount: Pick<SignalAmount, "min" | "max">): "salary_range" | "salary_fixed" | "salary_max" | "salary_min" {
  if (amount.min !== null && amount.max !== null) return amount.min === amount.max ? "salary_fixed" : "salary_range";
  return amount.max !== null ? "salary_max" : "salary_min";
}

/** One signal ready to be stored (`signals` without id / job / timestamp). */
export const SIGNAL_QUOTE_SOURCES = ["description", "structured"] as const;
/** Same values as the `signal_quote_source` enum of the database. */
export type SignalQuoteSource = (typeof SIGNAL_QUOTE_SOURCES)[number];

export interface SignalDraft {
  /** Category id. */
  tier: SignalCategoryId;
  kind: string;
  /** Amount category: a `SignalAmount`; null otherwise. */
  value: SignalAmount | null;
  /** C7: verbatim substring of the JD, or (`structured`) the text of the source's own salary field. */
  quote: string;
  /** Index of `quote` in the JD text; null for a `structured` quote. */
  quoteOffset: number | null;
  /** Default `description`. */
  quoteSource?: SignalQuoteSource;
  extractor: "rule" | "ai";
}

export interface Span {
  start: number;
  end: number;
}
