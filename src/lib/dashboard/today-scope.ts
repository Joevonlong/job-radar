/**
 * What the Today list is made of: jobs first seen inside the latest cycle's window and jobs first seen today. The two
 * sets overlap and either can be empty (early morning: this round ran last night, nothing new yet today), so the count line says
 * how many of the listed jobs belong to each. Pure; `listTodayJobs` does the same selection in SQL.
 */

export interface TodayScopeCycle {
  startedAt: Date;
  finishedAt: Date | null;
}

export interface TodayScopeCounts {
  /** Listed jobs first seen inside the latest cycle's window; null when no cycle has run yet. */
  cycle: number | null;
  /** Listed jobs first seen on the calendar day of `now` in `timezone`. */
  today: number;
}

/** `YYYY-MM-DD` of an instant in `timezone`. */
function localDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function countTodayScope(jobs: ReadonlyArray<{ firstSeenAt: Date }>, options: { now: Date; timezone: string; cycle: TodayScopeCycle | null }): TodayScopeCounts {
  const day = localDay(options.now, options.timezone);
  const { cycle } = options;
  let inCycle = 0;
  let inToday = 0;
  for (const job of jobs) {
    if (localDay(job.firstSeenAt, options.timezone) === day) inToday += 1;
    // a cycle that is still running has no end yet: nothing can have been first seen after now
    if (cycle && job.firstSeenAt >= cycle.startedAt && (cycle.finishedAt === null || job.firstSeenAt <= cycle.finishedAt)) inCycle += 1;
  }
  return { cycle: cycle ? inCycle : null, today: inToday };
}
