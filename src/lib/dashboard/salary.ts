import type { Locale } from "@/i18n/locale";
import { annualBaseFigure, baseRangeIn, summarizeMonthSalaries, type MonthSalaryFigure } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";
import { formatSalary, type SalaryPeriod } from "@/lib/format/numbers";

import { signalAmountLabel } from "./signal-label";

export interface SalaryDisplay {
  /**
   * The salary in `formatSalary`'s format, the posting's own currency and period ("€85–105k /年", "$140–170k /年", "€60–80 /小时");
   * null when there are no readable numbers (only the raw text is shown then).
   */
  normalized: string | null;
  /** A salary in another currency with a configured rate: its figure in the base currency ("≈ €139–163k /年"); null for the base currency itself and without a rate. */
  eurApprox: string | null;
  raw: string | null;
  /** The posting named no period; the pipeline read the amount as annual. Shown as a note, never silently. */
  periodAssumed: boolean;
  /** Possibly another region's pay, with the stated currency for the note; null = nothing says so. */
  otherRegion: { reason: "currency" | "description"; currency: string | null } | null;
  /** The amount includes a variable part (OTE). */
  includesVariable: boolean;
}

/**
 * Normalized salary text (C3: only what the posting states; a missing bound reads "up to" / "from"), written by `formatSalary` like
 * every other salary on the page. Per-year amounts (`perYear`, from the pipeline's period factors) are preferred so salaries
 * compare; otherwise the amounts as stated, with their period.
 */
export function describeSalary(salary: JobSalary, locale: Locale): SalaryDisplay {
  const raw = salary.raw.trim() !== "" ? salary.raw : null;
  const perYear = salary.perYear && (salary.perYear.min !== null || salary.perYear.max !== null) ? salary.perYear : null;
  const range = perYear ?? { min: salary.min, max: salary.max };
  const period: SalaryPeriod | null = perYear ? "year" : salary.period;
  const base = { raw, periodAssumed: salary.periodAssumed, otherRegion: salary.otherRegion ? { reason: salary.otherRegion, currency: salary.currency } : null, includesVariable: salary.includesVariable === true };
  const currency = salary.currency ?? undefined;
  // a per-year figure computed from a monthly / weekly / daily / hourly one is an estimate: "≈ €86k /年", whole k
  const converted = perYear !== null && salary.period !== null && salary.period !== "year";
  const normalized = formatSalary({ ...range, ...(currency ? { currency } : {}), ...(converted ? { approx: true } : {}) }, { locale, ...(period ? { period } : {}) });
  if (normalized === null) return { normalized: null, eurApprox: null, ...base };
  // another currency converted with pipeline.yaml `salary.fx_rates`: the base-currency figure next to it
  const eurApprox =
    salary.baseCurrency !== null && salary.currency !== salary.baseCurrency && salary.basePerYear
      ? formatSalary({ ...salary.basePerYear, currency: salary.baseCurrency, approx: true }, { locale, period: "year" })
      : null;
  return { normalized, eurApprox, ...base };
}

/**
 * Is the annual figure an estimate, not what the posting states (tokens.md "数字格式": a converted amount is written "≈ €86k")?
 * It is when the per-year amount was computed from a monthly / weekly / daily / hourly one (`period`), or, on the base basis
 * (`basePerYear`), when the posting's currency is not the base currency. The ONE place this is decided: the list, the ticker, the board and the
 * detail page all take `approx` from here, so one job never reads "€86.4k" in one place and "≈ €86k" in another.
 */
export function isApproxAnnual(salary: Pick<JobSalary, "currency" | "period" | "baseCurrency">, basis: "base" | "own"): boolean {
  const periodConverted = salary.period !== null && salary.period !== "year";
  const currencyConverted = basis === "base" && salary.currency !== null && salary.currency !== salary.baseCurrency;
  return periodConverted || currencyConverted;
}

/** The annual range a job is shown with everywhere (label, ticker, board card): numbers, currency and whether it is an estimate. */
export interface AnnualSalaryFigure {
  min: number | null;
  max: number | null;
  currency: string;
  approx: boolean;
  otherRegion: boolean;
}

/**
 * The annual range of a job as one view model: per year in the base currency when the pipeline has it, else the per-year amounts
 * in the posting's own currency (no rate); a salary under review is not shown. Never from the raw text. Null = nothing to show.
 */
export function annualSalaryFigure(salary: JobSalary | null): AnnualSalaryFigure | null {
  if (!salary || salary.qualityStatus === "review") return null;
  const base = salary.baseCurrency !== null && salary.basePerYear && (salary.basePerYear.min !== null || salary.basePerYear.max !== null) ? salary.basePerYear : null;
  const own = salary.perYear && salary.currency && (salary.perYear.min !== null || salary.perYear.max !== null) ? salary.perYear : null;
  const range = base ?? own;
  const currency = base ? salary.baseCurrency : salary.currency;
  if (!range || currency === null) return null;
  return {
    min: range.min,
    max: range.max,
    currency,
    approx: isApproxAnnual(salary, base ? "base" : "own"),
    otherRegion: Boolean(salary.otherRegion),
  };
}

/**
 * The compensation a list row shows, as one annual range: "€85–105k", "≤ €120k", "≥ €80k", and "≈ €86k" for a converted one.
 * Built from the normalized per-year fields only (`annualSalaryFigure`), never from the raw text; a salary whose quality
 * status is `review` is not shown at all. Null = nothing to show.
 */
export function annualSalaryLabel(salary: JobSalary | null, locale: string): string | null {
  const figure = annualSalaryFigure(salary);
  if (!figure) return null;
  return signalAmountLabel({ min: figure.min, max: figure.max, currency: figure.currency }, locale, { approx: figure.approx });
}

/** What the list needs to draw a salary: the annual range in the base currency, whether it may be another region's pay, and the posting's own figure. */
export interface ListSalary {
  /** Base currency a year, the normalized (`basePerYear`) range; null = that bound is not stated. */
  min: number | null;
  max: number | null;
  /** Possibly another region's pay: drawn hatched, no percentile. */
  otherRegion: boolean;
  /** The range is converted (monthly rate, another currency): written "≈ €86k" (`isApproxAnnual`). */
  approx: boolean;
  /** The figure in the posting's own currency ("$140–170k"), only when it is not the base currency; null otherwise. */
  figure: string | null;
}

/**
 * The salary of a row as numbers for the mini axis. Same rule as `annualSalaryLabel`: only normalized per-year figures, a salary
 * under review is not shown. A salary without a figure in the base currency `currency` (a currency without a configured rate, or worked
 * out before the base currency changed) has no place on the axis: null (the row falls back to its text label).
 */
export function listSalary(salary: JobSalary | null, locale: string, currency: string): ListSalary | null {
  if (!salary || salary.qualityStatus === "review") return null;
  const eur = baseRangeIn(salary, currency);
  if (!eur || (eur.min === null && eur.max === null)) return null;
  const own = salary.currency && salary.currency !== currency && salary.perYear && (salary.perYear.min !== null || salary.perYear.max !== null) ? salary.perYear : null;
  return {
    min: eur.min,
    max: eur.max,
    otherRegion: Boolean(salary.otherRegion),
    approx: isApproxAnnual(salary, "base"),
    figure: own ? signalAmountLabel({ min: own.min, max: own.max, currency: salary.currency }, locale, { approx: salary.period !== null && salary.period !== "year" }) : null,
  };
}

/**
 * "Pays more than N% of the disclosed jobs" of a list row: the job's figure against this month's figures, by the same function the
 * detail page uses (`summarizeMonthSalaries`), so list and detail always agree. Null without `month`, without a comparable salary
 * (not disclosed, under review, another region's pay) and below the minimum sample.
 */
export function rowSalaryPercentile(job: { id: number; salary: JobSalary | null }, month: { figures: readonly MonthSalaryFigure[]; minSample: number; currency: string } | undefined): number | null {
  if (!month) return null;
  return summarizeMonthSalaries(month.figures, { jobId: job.id, figure: annualBaseFigure(job.salary, month.currency), minSample: month.minSample }).percentile;
}
