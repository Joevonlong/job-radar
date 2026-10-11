import { sql, type SQL } from "drizzle-orm";

import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";

import { jobs } from "../schema";

/**
 * One bound of the stored salary per year in the base currency `currency` (`basePerYear`; a salary stored before
 * has only `eurPerYear`, which is that figure while the base is EUR), as a number; null when the bound is not stated or
 * the salary was worked out in another base currency (it is not compared until the pipeline worked it out again).
 */
export function baseBoundSql(key: "max" | "min", currency: string): SQL {
  const figure = sql`coalesce(${jobs.salaryJson} #> ${sql.raw(`'{basePerYear,${key}}'`)}, ${jobs.salaryJson} #> ${sql.raw(`'{eurPerYear,${key}}'`)})`;
  return sql`(case when coalesce(${jobs.salaryJson} ->> 'baseCurrency', ${LEGACY_BASE_CURRENCY}) = ${currency} and jsonb_typeof(${figure}) = 'number' then (${figure} #>> '{}')::numeric end)`;
}

/**
 * `annualBaseFigure` (lib/domain/salary.ts) in SQL: the middle of a complete range per year in the base currency, else the
 * one stated bound. The one definition of "the figure of a stated salary" behind every median and percentile (detail
 * page, job list, /me floor preview, /insights); the TypeScript twin is the reference, `comparableSalaryWhere` its other half.
 */
export function annualBaseFigureSql(currency: string): SQL {
  return sql`coalesce((${baseBoundSql("min", currency)} + ${baseBoundSql("max", currency)}) / 2, ${baseBoundSql("max", currency)}, ${baseBoundSql("min", currency)})`;
}

/** A salary that counts for a median: stated as an object, not under review, not possibly another region's pay. */
export const comparableSalaryWhere = sql`jsonb_typeof(${jobs.salaryJson}) = 'object'
  and ${jobs.salaryJson}->>'qualityStatus' is distinct from 'review'
  and ${jobs.salaryJson}->>'otherRegion' is null`;
