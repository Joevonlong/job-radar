import { baseRangeIn } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";

import { isApproxAnnual } from "./salary";

/**
 * Does the stated salary reach your floor (`preferences.yaml: salary_floor_year`)? The same reading as the filter:
 * the upper end of the range counts (the lower end of a "from X" range).
 * - `no_salary`: nothing stated (or no figure in the base currency): not judged, not a fail (C3).
 * - `other_region`: the figure is possibly another region's pay: not judged.
 * - `no_floor`: no floor is set.
 */
export type FloorCheckState = "pass" | "fail" | "no_salary" | "other_region" | "no_floor";

export interface FloorCheck {
  state: FloorCheckState;
  /** The figure that was compared, base currency a year; null unless `pass` / `fail`. */
  top: number | null;
  floor: number | null;
  /** The base currency `top` and `floor` are in. */
  currency: string;
  /** `top` is a converted figure (a monthly rate, another currency): written "≈ €86k" like everywhere else (`isApproxAnnual`). */
  approx: boolean;
}

export function floorCheck(salary: JobSalary | null, floor: number | null, currency: string): FloorCheck {
  if (floor === null) return { state: "no_floor", top: null, floor, approx: false, currency };
  if (!salary || salary.qualityStatus === "review") return { state: "no_salary", top: null, floor, approx: false, currency };
  const range = baseRangeIn(salary, currency);
  const top = range ? (range.max ?? range.min ?? null) : null;
  if (top === null) return { state: "no_salary", top: null, floor, approx: false, currency };
  if (salary.otherRegion) return { state: "other_region", top: null, floor, approx: false, currency };
  return { state: top >= floor ? "pass" : "fail", top, floor, approx: isApproxAnnual(salary, "base"), currency };
}
