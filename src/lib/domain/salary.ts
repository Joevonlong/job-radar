import type { JobSalary } from "./types";

export type ComparableSalaryRange = { min: number; max: number; currency: string; period: "year" };

/**
 * The salary per year in the base currency `currency`, or null when it has none or it is in another one (a
 * salary worked out before the base currency changed is not compared until the pipeline worked it out again).
 */
export function baseRangeIn(salary: Pick<JobSalary, "basePerYear" | "baseCurrency">, currency: string): JobSalary["basePerYear"] {
  return salary.baseCurrency === currency ? salary.basePerYear : null;
}

/** A complete, trustworthy range per year in the base currency, or null (an open-ended or unreviewed salary is not comparable). */
export function comparableAnnualRange(salary: JobSalary | null, currency: string): ComparableSalaryRange | null {
  if (!salary || salary.qualityStatus === "review") return null;
  const range = baseRangeIn(salary, currency);
  if (!range || range.min == null || range.max == null) return null;
  return range.min > 0 && range.min <= range.max ? { min: range.min, max: range.max, currency, period: "year" } : null;
}

export function salaryRangeOverlaps(salary: JobSalary | null, currency: string, requestedMin?: number, requestedMax?: number): boolean {
  if (requestedMin == null && requestedMax == null) return true;
  const range = comparableAnnualRange(salary, currency);
  if (!range) return false;
  return (requestedMin == null || range.max >= requestedMin) && (requestedMax == null || range.min <= requestedMax);
}

/**
 * One comparable annual figure of a stated salary in the base currency `currency`: the middle of a complete range, or
 * the one bound a half-open range states ("up to 120k" -> 120k). Null for no salary, an unreviewed one, one possibly of
 * another region or one without a figure in the base currency. Used for the median and the percentile of the
 * detail page; the same rule is written in SQL (`annualBaseFigureSql`).
 */
export function annualBaseFigure(salary: JobSalary | null, currency: string): number | null {
  if (!salary || salary.qualityStatus === "review" || salary.otherRegion) return null;
  const range = baseRangeIn(salary, currency);
  if (!range) return null;
  const { min, max } = range;
  const figure = min != null && max != null ? (min + max) / 2 : (max ?? min ?? null);
  return figure !== null && figure > 0 ? figure : null;
}

/** One job's `annualBaseFigure` among those first seen this month (`listMonthSalaryFigures`). */
export interface MonthSalaryFigure {
  id: number;
  figure: number;
}

export interface MonthSalarySummary {
  /** Jobs of the month with a comparable figure, the job itself included when it is one of them. */
  count: number;
  /** Median of the figures, base currency a year; null below `minSample`. */
  median: number | null;
  /** Share (0-100) of the month's other jobs this job's figure is above; null below `minSample`, without a figure of its own, or without other jobs. */
  percentile: number | null;
}

/**
 * The one definition of "median" and "pays more than N% of the disclosed jobs", used by the detail page (`loadMonthSalaryStats`)
 * and by every row of the job list, so both always give the same number for the same job: figures are `annualBaseFigure`s of this
 * month's jobs; the percentile is the share of the *other* jobs (`jobId` left out) strictly below `figure`; with fewer than
 * `minSample` figures (`ui.yaml: salary_stats.min_sample`) there is no median and no percentile.
 */
export function summarizeMonthSalaries(figures: readonly MonthSalaryFigure[], input: { jobId: number; figure: number | null; minSample: number }): MonthSalarySummary {
  const count = figures.length;
  if (count < input.minSample || count === 0) return { count, median: null, percentile: null };
  const sorted = figures.map((entry) => entry.figure).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  let others = 0;
  let below = 0;
  if (input.figure !== null) {
    for (const entry of figures) {
      if (entry.id === input.jobId) continue;
      others += 1;
      if (entry.figure < input.figure) below += 1;
    }
  }
  return { count, median, percentile: input.figure !== null && others > 0 ? (below / others) * 100 : null };
}
