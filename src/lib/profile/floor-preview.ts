/**
 * The /me salary-floor preview. Pure and free of server imports: the page computes nothing, the client
 * counts on every slider move, and the count is the hard filter's own salary rule (`salaryBelowFloor`), so the
 * preview can never disagree with what a save would do.
 */
import { salaryBelowFloor } from "@/lib/filter/salary";

/** The stated pay of one disclosed job a year in the base currency: what the hard filter's salary rule reads (`basePerYear`). */
export interface StatedSalary {
  min: number | null;
  max: number | null;
  /**
   * Possibly another region's pay. The hard filter judges such a salary like any other (its upper bound against the floor),
   * so it stays in the count the preview gives; it is marked, and left out of the median (the one definition of `summarizeMonthSalaries`).
   */
  otherRegion?: boolean;
}

/**
 * The median line of the preview: `summarizeMonthSalaries` over this month's comparable salaries (`listMonthSalaryFigures`), the
 * same figure and the same minimum sample (`ui.yaml: salary_stats.min_sample`) as the detail page's salary axis.
 */
export interface SalaryMedian {
  /** Base currency a year; null below `minSample`. */
  value: number | null;
  /** Comparable salaries of the month the median is made of. */
  count: number;
  minSample: number;
}

/** The one figure a job stands for in the distribution strip: its upper bound, else its lower bound. */
export function shownSalary(salary: StatedSalary): number {
  return salary.max ?? salary.min ?? 0;
}

export interface FloorPreview {
  /** Disclosed jobs this month. */
  total: number;
  /** Of them: how many the hard filter would drop at this floor. */
  filtered: number;
  /** `filtered / total`, whole percent; null when nothing is disclosed (C3: no basis, not 0 %). */
  percent: number | null;
}

/** Whether the hard filter drops this job at `floor` a year (the figures are already in the base currency). */
export function isBelowFloor(salary: StatedSalary, floor: number): boolean {
  return salaryBelowFloor({ qualityStatus: "valid", basePerYear: { min: salary.min, max: salary.max }, baseCurrency: "base" }, floor, "base") !== null;
}

/** How many of `salaries` the salary rule drops at `floor` a year. */
export function previewFloor(salaries: readonly StatedSalary[], floor: number): FloorPreview {
  const filtered = salaries.filter((salary) => isBelowFloor(salary, floor)).length;
  return { total: salaries.length, filtered, percent: salaries.length === 0 ? null : Math.round((filtered / salaries.length) * 100) };
}
