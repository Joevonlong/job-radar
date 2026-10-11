import { annualSalaryFigure } from "@/lib/dashboard/salary";
import type { JobSalary } from "@/lib/domain/types";

/** What a card needs to write a salary: annual bounds in one currency (numbers, formatted by `formatSalary` in the component). */
export interface BoardSalary {
  min: number | null;
  max: number | null;
  currency: string;
  /** Converted (another currency, or a monthly / hourly rate times its factor): written `≈`. */
  approx: boolean;
  /** Possibly another region's pay. */
  otherRegion: boolean;
}

/**
 * The annual range of a job: the very view model of the list row's label (`annualSalaryFigure`), so a converted figure is "≈ €86k"
 * on the board as in the list and on the detail page. Null = nothing stated.
 */
export function boardSalaryOf(salary: JobSalary | null): BoardSalary | null {
  return annualSalaryFigure(salary);
}
