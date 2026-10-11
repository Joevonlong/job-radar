import { and, eq, ne, sql } from "drizzle-orm";

import { shownSalary, type StatedSalary } from "@/lib/profile/floor-preview";

import type { Db } from "../client";
import { jobs } from "../schema";
import { parseSalary } from "./parse";
import { baseRangeIn } from "@/lib/domain/salary";

/**
 * Stated salaries of this month's jobs (the /me floor preview): jobs first seen since the start of the
 * calendar month in `timezone`, not closed, whose salary is usable (`qualityStatus = valid`, an EUR-per-year
 * range with at least one bound). The same jobs the hard filter judges by `salaryBelowFloor`. Sorted by the
 * figure shown for a job (upper bound, else lower), ascending. One row per job, a small set by nature.
 */
export async function listMonthStatedSalaries(db: Db, options: { timezone: string; now?: Date; currency: string }): Promise<StatedSalary[]> {
  const now = (options.now ?? new Date()).toISOString();
  const monthStart = sql`((date_trunc('month', ${now}::timestamptz at time zone ${options.timezone})) at time zone ${options.timezone})`;
  const rows = await db
    .select({ salaryJson: jobs.salaryJson })
    .from(jobs)
    .where(and(ne(jobs.status, "closed"), sql`${jobs.salaryJson} is not null and ${jobs.salaryJson} <> 'null'::jsonb`, sql`${jobs.firstSeenAt} >= ${monthStart}`, sql`${jobs.firstSeenAt} <= ${now}::timestamptz`, eq(sql`jsonb_typeof(${jobs.salaryJson})`, "object")));

  const out: StatedSalary[] = [];
  for (const row of rows) {
    const salary = parseSalary(row.salaryJson);
    const range = salary === null || salary.qualityStatus !== "valid" ? null : baseRangeIn(salary, options.currency);
    if (salary === null || range === null) continue;
    const { min, max } = range;
    if (min === null && max === null) continue;
    out.push({ min, max, ...(salary.otherRegion ? { otherRegion: true } : {}) });
  }
  return out.sort((a, b) => shownSalary(a) - shownSalary(b));
}
