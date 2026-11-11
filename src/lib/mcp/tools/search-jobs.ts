import { z } from "zod";

import { SEARCH_QUERY_MAX_CHARS } from "@/lib/config/schemas/job-search";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listJobs, SearchTimeoutError } from "@/lib/db/queries/jobs";
import { loadBlocks } from "@/lib/capabilities/blocks";
import { searchJobCardBlocks, summaryAccess } from "@/lib/mcp/job-card-blocks";
import { jobsListFilters } from "@/lib/jobs/list-filters";
import type { JobsSearchParams } from "@/lib/jobs/search-params";
import { visaFilterAvailable } from "@/lib/visa/filter";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import { APPLICATION_FILTER_STATUSES, JOB_SCOPES, JOB_WORKPLACES, MIN_SALARY_MAX, VISA_FILTERS } from "@/lib/jobs/constants";

import { ToolFailure, type McpContext } from "../context";
import { searchJobsOutput, searchJobsOutputFor, toJobCardDto, type SearchJobsOutput } from "../dto";
import { shortFieldCleaner } from "../guard";
import { readTraps, resultLimit, truncationNotice } from "./shared";

/** Longest search text (the cap of job-search.yaml `query.max_chars`) and city name a call accepts. */
export const MAX_QUERY_CHARS = SEARCH_QUERY_MAX_CHARS;
export const MAX_CITY_CHARS = 120;
export const SEARCH_SORTS = ["relevance", "rank", "posted", "first_seen"] as const;

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
    search_in: z.enum(["summary", "all"]).optional().describe(t("params.searchIn")),
    country: z.array(z.string().regex(/^[A-Za-z]{2}$/).transform((code) => code.toUpperCase())).min(1).max(20).optional().describe(t("params.country")),
    city: z.string().trim().min(1).max(MAX_CITY_CHARS).optional().describe(t("params.city")),
    workplace: z.array(z.enum(JOB_WORKPLACES)).min(1).max(JOB_WORKPLACES.length).optional().describe(t("params.workplace")),
    min_rank: z.number().min(0).max(100).optional().describe(t("params.minRank")),
    min_annual_salary: z.number().min(0).max(MIN_SALARY_MAX).optional().describe(t("params.minAnnualSalary")),
    since: day(t("params.since")).optional(),
    until: day(t("params.until")).optional(),
    application_status: z.array(z.enum(APPLICATION_FILTER_STATUSES)).min(1).max(APPLICATION_FILTER_STATUSES.length).optional().describe(t("params.applicationStatus")),
    scope: z.enum(JOB_SCOPES).optional().describe(t("params.scope")),
    unseen_only: z.boolean().optional().describe(t("params.unseenOnly")),
    favorites_only: z.boolean().optional().describe(t("params.favoritesOnly")),
    visa: z.enum(VISA_FILTERS).optional().describe(t("params.visa")),
    ghost: z.enum(["only", "hide"]).optional().describe(t("params.ghost")),
    sort: z.enum(SEARCH_SORTS).optional().describe(t("params.sort")),
    limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(t("params.limit")),
  });
}

export type SearchJobsArgs = z.infer<ReturnType<typeof searchJobsInput>>;

/** Every /jobs URL key is explicit; absent scope retains the legacy current-jobs rule. */
export function searchJobsParams(args: SearchJobsArgs): JobsSearchParams {
  return {
    scope: args.scope ?? null,
    q: args.query ?? null,
    searchIn: args.search_in === "all" ? "all" : null,
    source: [], city: args.city ? [args.city] : [], country: args.country ?? [], company: [],
    workplace: args.workplace ?? [], contract: [], status: [], reason: [], app: args.application_status ?? [],
    minScore: args.min_rank ?? null, minSalary: args.min_annual_salary ?? null,
    from: args.since ?? null, to: args.until ?? null, within: null, dateBy: null,
    salary: null, filtered: null, filteredOnly: null, hideLang: null, hideGerman: null, high: null, t12: null, trap: null,
    visa: args.visa ?? null, ghost: args.ghost ?? null, fav: args.favorites_only ?? null, unseen: args.unseen_only ?? null,
    relisted: null, sort: args.sort ?? null, dir: null, page: 1,
  };
}

/**
 * Cards share /jobs filters, hiding hard-filtered and archived jobs by default. Unlike the web's query parser, MCP uses its
 * lenient search plan so unreadable pipeline settings do not take text search down. The existing MCP default sort stays rank
 * without a query (including archive); every explicit MCP sort has the same web equivalent. The star and seen filters would
 * reveal tracking data through the jobs they keep, so without tracking permission they are refused as invalid input.
 */
export async function searchJobs(ctx: McpContext, args: SearchJobsArgs): Promise<SearchJobsOutput> {
  if ((args.favorites_only === true || args.unseen_only === true) && !ctx.permissions?.has("tracking:read")) throw new ToolFailure("invalid_input", ctx.text("errors.trackingFilter"));
  const params = searchJobsParams(args);
  const [visa, ghost] = await Promise.all([visaFilterAvailable(ctx.db), ghostFilterAvailable(ctx.db)]);
  const filters = await jobsListFilters(ctx.db, { ...params, q: null }, { visa, ghost, now: ctx.now() });
  filters.search = args.query ? ctx.searchPlan(args.query) : null;

  const limit = resultLimit(ctx, args.limit);
  const page = await listJobs(ctx.db, { filters, sort: args.sort ?? (args.query ? "relevance" : "rank"), page: 1, pageSize: limit, timezone: ctx.timezone(), visa, ghost }).catch((error: unknown) => {
    if (error instanceof SearchTimeoutError) throw new ToolFailure(error.code, ctx.text("errors.searchTimeout"));
    throw error;
  });
  const traps = readTraps(ctx);
  const clean = shortFieldCleaner(traps);
  const access = await summaryAccess(ctx, page.jobs, traps);
  const jobs = await Promise.all(page.jobs.map(async (card) => ({
    ...toJobCardDto(card, clean),
    ...await loadBlocks(searchJobCardBlocks, ctx, { card, clean, summaryFailure: access.reason ?? (access.allowed.has(card.id) ? null : "not_scanned") }, undefined),
  })));
  const truncated = page.total > jobs.length;
  const notices = [ctx.text("notice.thirdParty"), ...(truncated ? [truncationNotice(ctx, jobs.length, page.total, limit)] : [])];
  const output = searchJobsOutput.parse({ notices, total: page.total, returned: jobs.length, truncated, jobs });
  const derivedNotices: string[] = [];
  if (output.jobs.some((job) => job.match?.summary !== null && job.match?.summary !== undefined)) derivedNotices.push(ctx.text("notice.derived"));
  if (output.jobs.some((job) => job.match?.summary_withheld != null)) derivedNotices.push(ctx.text("notice.derivedWithheld"));
  notices.splice(1, 0, ...derivedNotices);
  return searchJobsOutputFor(ctx.permissions ?? new Set()).parse({ ...output, notices });
}
