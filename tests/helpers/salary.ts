import { jobSalarySchema, type JobSalary } from "@/lib/domain/types";

/**
 * A stored salary read the way the app reads it: a salary written with only `eurPerYear` (the shape before the base
 * currency) gets that figure as its EUR base figure.
 */
export function asSalary(value: Record<string, unknown>): JobSalary {
  return jobSalarySchema.parse(value);
}
