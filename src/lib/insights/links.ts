import { JOB_STATUSES } from "@/lib/jobs/constants";

import type { DayWindow } from "./range";

/** The /jobs filters /insights can name (a subset of `jobsSearchParsers`, same keys). */
export interface JobsLink {
  range?: DayWindow;
  source?: string;
  city?: string;
  workplace?: "remote";
  salary?: true;
  /** Include the jobs the hard filter removed (they are hidden on /jobs by default). */
  filtered?: true;
  /** Only the jobs the hard filter removed. */
  filteredOnly?: true;
  /** Only jobs with a high-value signal. */
  high?: true;
}

/**
 * `/jobs?...` for a set of filters. Booleans are `true` or absent, like nuqs writes them. Every link names all job statuses: the
 * /insights counts include closed jobs, which /jobs hides unless a job status is filtered for, so the list a number opens
 * has that number of jobs.
 */
export function jobsHref(link: JobsLink): string {
  const params = new URLSearchParams();
  if (link.range) {
    params.set("from", link.range.from);
    params.set("to", link.range.to);
  }
  if (link.source) params.set("source", link.source);
  if (link.city) params.set("city", link.city);
  if (link.workplace) params.set("workplace", link.workplace);
  if (link.salary) params.set("salary", "true");
  if (link.filtered) params.set("filtered", "true");
  if (link.filteredOnly) params.set("filteredOnly", "true");
  if (link.high) params.set("high", "true");
  for (const status of JOB_STATUSES) params.append("status", status);
  return `/jobs?${params.toString()}`;
}

/** `/insights?range=N`; the default range has no parameter. */
export function insightsHref(days: number, defaultDays: number): string {
  return days === defaultDays ? "/insights" : `/insights?range=${days}`;
}
