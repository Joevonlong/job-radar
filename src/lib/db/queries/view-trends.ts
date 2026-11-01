import { and, eq, isNull, ne, notExists, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { applications, companies, jobs } from "../schema";
import { withCurrentScore, currentScoreRead, hideGermanLevels, currentScore } from "./job-cards";
import { buildJobConditions, type JobFilters } from "./jobs";
import { hasHighValueSignal } from "./signal-filter";

/** One saved view as the trend query needs it: its id and its filters in the form the job queries take. */
export interface ViewTrendInput {
  id: string;
  filters: JobFilters;
}

/** `YYYY-MM-DD` of `now` in `timezone`, minus `daysAgo` calendar days. */
export function localDayKey(now: Date, timezone: string, daysAgo = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const date = new Date(Date.UTC(pick("year"), pick("month") - 1, pick("day") - daysAgo));
  return date.toISOString().slice(0, 10);
}

/**
 * New jobs per local day for each saved view over the last `days` days (oldest first, today last) - the
 * sparkline of /interests. One query for all views: the jobs of the window are grouped by day once
 * and every view is a `count(*) filter (where ...)` over the same filters Today applies to that view
 * (`buildJobConditions`, the hard-filter exclusion unless the view asks for it, ignored jobs out unless the view
 * asks for them by status). A view's dates are ignored: the window is the last `days` days.
 */
export async function getViewDailyCounts(db: Db, options: { views: readonly ViewTrendInput[]; timezone: string; now: Date; days: number }): Promise<Map<string, number[]>> {
  return currentScoreRead(db, async () => {
    const result = new Map<string, number[]>();
    if (options.views.length === 0 || options.days < 1) return result;

    const latest = await currentScore(db, "set");
    const dayKeys = Array.from({ length: options.days }, (_, index) => localDayKey(options.now, options.timezone, options.days - 1 - index));
    const firstDay = dayKeys[0] as string;

    const counts: Record<string, SQL<number>> = {};
    options.views.forEach((view, index) => {
      const filters: JobFilters = { ...view.filters, from: null, to: null, within: null, dateField: null };
      const conditions: SQL[] = [];
      if (!filters.applicationStatuses?.includes("archived")) {
        conditions.push(notExists(db.select({ one: sql`1` }).from(applications).where(and(eq(applications.jobId, jobs.id), eq(applications.status, "archived")))));
      }
      if (!filters.includeFiltered) {
        const visible = or(isNull(latest.filterResult), ne(latest.filterResult, "filtered_out"));
        if (visible) conditions.push(visible);
      }
      if (filters.highValue) conditions.push(hasHighValueSignal(db, filters.highValue));
      const german = hideGermanLevels(latest, filters.hideGermanLevels ?? []);
      if (german) conditions.push(german);
      const rest = buildJobConditions(db, { ...filters, highValue: null, hideGermanLevels: null, includeFiltered: true }, options.timezone, latest);
      if (rest) conditions.push(rest);
      const where = and(...conditions);
      counts[`v${index}`] = where ? sql<number>`(count(*) filter (where ${where}))::int` : sql<number>`count(*)::int`;
    });

    const day = sql<string>`to_char((${jobs.firstSeenAt} at time zone ${options.timezone})::date, 'YYYY-MM-DD')`;
    const rows = await withCurrentScore(db, latest)
      .select({ day, ...counts })
      .from(jobs)
      .innerJoin(companies, eq(companies.id, jobs.companyId))
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(sql`(${jobs.firstSeenAt} at time zone ${options.timezone})::date >= ${firstDay}::date`)
      // by position: the day expression carries a bound time-zone parameter, which Postgres would not match to the select list
      .groupBy(sql`1`);

    const byDay = new Map(rows.map((row) => [row.day, row as Record<string, unknown>]));
    options.views.forEach((view, index) => {
      result.set(
        view.id,
        dayKeys.map((key) => Number(byDay.get(key)?.[`v${index}`] ?? 0)),
      );
    });
    return result;
  });
}
