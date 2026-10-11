import { baseRangeIn } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";

/** The part of a stored salary the floor rule reads. */
export type FloorSalary = Pick<JobSalary, "qualityStatus" | "basePerYear" | "baseCurrency">;

/**
 * The salary rule of the hard filter: a posting is excluded when its stated upper bound,
 * a year in the base currency `currency`, is below the floor. Anything the posting does not state (no salary,
 * not convertible, flagged implausible, no upper bound) never excludes (C3), and neither does a figure in another
 * base currency (worked out before the base currency changed).
 *
 * Returns the upper bound that fell below the floor (the reason payload), or null when the job passes.
 * Pure and free of server imports: the filter and the /me floor preview share this one definition.
 */
export function salaryBelowFloor(salary: FloorSalary | null, floor: number, currency: string): number | null {
  if (floor <= 0 || salary === null || salary.qualityStatus !== "valid") return null;
  const max = baseRangeIn(salary, currency)?.max ?? null;
  return max !== null && max < floor ? max : null;
}
