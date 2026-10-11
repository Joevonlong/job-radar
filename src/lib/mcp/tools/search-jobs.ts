import { z } from "zod";

import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listJobs, type JobFilters } from "@/lib/db/queries/jobs";
import { APPLICATION_FILTER_STATUSES, JOB_WORKPLACES, MIN_SALARY_MAX } from "@/lib/jobs/constants";

import type { McpContext } from "../context";
import { searchJobsOutput, toJobCardDto, type SearchJobsOutput } from "../dto";
import { shortFieldCleaner } from "../guard";
import { readTraps, resultLimit, truncationNotice } from "./shared";

/** Longest search text and city name a call accepts. */
export const MAX_QUERY_CHARS = 200;
export const MAX_CITY_CHARS = 120;
export const SEARCH_SORTS = ["rank", "posted", "first_seen"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDay = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function searchJobsInput(ctx: Pick<McpContext, "text">) {
  const t = ctx.text;
  const day = (description: string) =>
    z
      .string()
      .regex(DAY, "expected YYYY-MM-DD")
      .refine(isCalendarDay, "not a calendar day")
      .describe(description);
  return z.strictObject({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS).optional().describe(t("params.query")),
    city: z.string().trim().min(1).max(MAX_CITY_CHARS).optional().describe(t("params.city")),
    workplace: z.array(z.enum(JOB_WORKPLACES)).min(1).max(JOB_WORKPLACES.length).optional().describe(t("params.workplace")),
    min_rank: z.number().min(0).max(100).optional().describe(t("params.minRank")),
    min_annual_salary: z.number().min(0).max(MIN_SALARY_MAX).optional().describe(t("params.minAnnualSalary")),
    since: day(t("params.since")).optional(),
    until: day(t("params.until")).optional(),
    application_status: z.array(z.enum(APPLICATION_FILTER_STATUSES)).min(1).max(APPLICATION_FILTER_STATUSES.length).optional().describe(t("params.applicationStatus")),
    sort: z.enum(SEARCH_SORTS).optional().describe(t("params.sort")),
    limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(t("params.limit")),
  });
}

export type SearchJobsArgs = z.infer<ReturnType<typeof searchJobsInput>>;

/**
 * Ranked job cards, the way the jobs list filters them: jobs the hard filter removed and closed jobs are left out. No JD text,
 * no score reasons.
 */
export async function searchJobs(ctx: McpContext, args: SearchJobsArgs): Promise<SearchJobsOutput> {
  const filters: JobFilters = { includeFiltered: false };
  if (args.query) {
    filters.q = args.query;
    filters.qLocationTerms = ctx.locationTerms(args.query);
  }
  if (args.city) {
    filters.cities = [args.city];
    filters.cityMembers = await ctx.cityMembers(ctx.db, args.city);
  }
  if (args.workplace) filters.workplaces = args.workplace;
  if (args.min_rank !== undefined) filters.minRank = args.min_rank;
  if (args.min_annual_salary !== undefined) {
    filters.minAnnualSalary = args.min_annual_salary;
    filters.baseCurrency = ctx.baseCurrency();
  }
  if (args.since) filters.from = args.since;
  if (args.until) filters.to = args.until;
  if (args.application_status) filters.applicationStatuses = args.application_status;

  const limit = resultLimit(ctx, args.limit);
  const page = await listJobs(ctx.db, { filters, sort: args.sort ?? "rank", page: 1, pageSize: limit, timezone: ctx.timezone() });
  const clean = shortFieldCleaner(readTraps(ctx));
  const jobs = page.jobs.map((card) => toJobCardDto(card, clean));
  const truncated = page.total > jobs.length;
  const notices = [ctx.text("notice.thirdParty"), ...(truncated ? [truncationNotice(ctx, jobs.length, page.total, limit)] : [])];
  return searchJobsOutput.parse({ notices, total: page.total, returned: jobs.length, truncated, jobs } satisfies SearchJobsOutput);
}
