// Frozen pre-projection query baseline.
import { and, asc, count, desc, eq, exists, inArray, isNull, lte, ne, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { applications, channels, companies, jobFavorites, jobSources, jobs, jobVisa, trapScans } from "@/lib/db/schema";
import { DEFAULT_SORT_DIR, MAX_FILTER_VALUE_CHARS, type ApplicationFilterStatus, type ArchiveReason, type GhostFilter, type JobScope, type JobSort, type SortDir, type TrapFilter, type VisaFilter } from "@/lib/jobs/constants";
import type { SearchPlan } from "@/lib/jobs/search-query";
import { resolveJobScope } from "@/lib/jobs/scope";
import { ghostTrustedKeys } from "@/lib/ghost/settings";

import { ghostFilterCondition } from "@/lib/db/repos/ghost";
import { seenSql } from "@/lib/db/repos/seen";
import { uxTablesReady } from "@/lib/db/repos/ux-tables";
import { jobHasCountryIn, jobLocationRows, jobSearchCondition, jobSearchOrderBy } from "@/lib/db/queries/job-search";
import { archiveReasonSql, effectiveStatusSql, jobScopeSql, lastListedSql } from "@/lib/db/queries/job-status";
import { cardColumns, hideGermanLevels, hydrateCards, latestScoreCte, latestScoreLateral, type CardRow, type LatestScore } from "./job-cards";
import { annualBaseFigureSql, baseBoundSql, comparableSalaryWhere } from "@/lib/db/queries/salary-figure";
import { hasHighValueSignal, policyCurrency, type HighValuePolicy } from "@/lib/db/queries/signal-filter";
import type { JobCard, JobStatus, Workplace } from "@/lib/db/queries/types";
import { listingReady } from "@/lib/db/repos/listing";
import { dormancyReady } from "@/lib/db/repos/dormancy";

export interface JobFilters {
  /** Latest qualifying relist falls within this badge window; ignored before the listing migration. */
  relistedSince?: Date | null;
  /** Null/absent keeps the legacy rule (current without statuses, all with statuses); explicit scope intersects statuses. */
  scope?: JobScope | null;
  /** Effective closure reasons, OR within this list and intersected with scope and every other filter; empty/null = no filter. */
  closedReasons?: readonly ArchiveReason[] | null;
  /** Parsed search terms; null/absent leaves the list unsearched. */
  search?: SearchPlan | null;
  /** Absent/null searches summary fields; all also searches descriptions and current translations. */
  searchIn?: "summary" | "all" | null;
  /** Exact location country codes, OR within this list. */
  countries?: readonly string[] | null;
  /** Source families (`channels.family`): the job has a source posting from a channel of any of these families. Empty / null = no filter; the same goes for the other lists below. */
  sources?: readonly string[] | null;
  /**
   * Only jobs of these companies (`companies.id`, resolved from the company filter's names by `resolveViewCompanyIds`). Null / absent =
   * no filter; an empty list = companies were picked but none matched: nothing is listed.
   */
  companyIds?: readonly number[] | null;
  /** Cities to show (any of them): group keys of the city dropdown (`src/lib/jobs/city-groups.ts`) or raw `locations_json[].city` values. */
  cities?: readonly string[] | null;
  /** The raw `locations_json[].city` values that make up `cities` (a metro area has many; the union); default: `cities` alone. */
  cityMembers?: readonly string[] | null;
  workplaces?: readonly Workplace[] | null;
  contracts?: readonly string[] | null;
  statuses?: readonly JobStatus[] | null;
  /** Application status is any of these; `new` also matches jobs without an application, `archived` = ignored. */
  applicationStatuses?: readonly ApplicationFilterStatus[] | null;
  /** Rank value (the score shown in the list) at least this; unscored and hard-filtered jobs have none and drop out. */
  minRank?: number | null;
  /** Stated salary, EUR per year (upper bound; the lower bound of an open-ended "from X"), at least this. Jobs without a usable salary drop out, but only when this is set. */
  /** Per year in the base currency `baseCurrency`. */
  minAnnualSalary?: number | null;
  /** The market's base currency the salary filters compare in; null = none (nothing compares), missing = EUR. */
  baseCurrency?: string | null;
  /** First-seen date range, inclusive, `YYYY-MM-DD` in `timezone`. */
  from?: string | null;
  to?: string | null;
  /** Only jobs whose posting states a salary. */
  salaryDisclosed?: boolean | null;
  /** Include jobs the hard filter removed. Off by default: they are hidden. */
  includeFiltered?: boolean | null;
  /** Only the jobs the hard filter removed (implies including them). */
  filteredOnly?: boolean | null;
  /** Only starred jobs. */
  favoritesOnly?: boolean | null;
  /** Hide jobs requiring one of these German levels (quick filter; the page derives them from me.yaml). */
  hideGermanLevels?: readonly string[] | null;
  /** Only jobs with a high-value signal under this policy (the "high-value signals only" quick filter); null = no filter. */
  highValue?: HighValuePolicy | null;
  /** Only jobs with an AI trap (`only`), or without one (`hide`). */
  trap?: TrapFilter | null;
  /**
   * The visa check: only jobs whose JD mentions visa support (`offered`), or every job except those whose JD refuses sponsorship or
   * requires a permit (`not_denied`: unclear and unchecked jobs stay). Set only when the `job_visa` table exists (`toJobFilters`).
   */
  visa?: VisaFilter | null;
  /**
   * The ghost job check: only jobs marked watch / likely (`only`), or every job except the likely ones (`hide`); a dismissed mark counts
   * as none, `all` = no filter. Set only when the check is on and the `job_ghost` table exists (`toJobFilters`).
   */
  ghost?: GhostFilter | null;
  /** Only jobs the user has not looked at yet. */
  unseenOnly?: boolean | null;
}

export interface ListJobsOptions {
  filters: JobFilters;
  sort: JobSort;
  /** The direction; absent / null = the sort's default (`DEFAULT_SORT_DIR`). */
  dir?: SortDir | null;
  /** 1-based; clamped to the last page. */
  page: number;
  pageSize: number;
  /** IANA zone the date range is interpreted in (schedule.yaml `timezone`). */
  timezone: string;
  /** Load the visa badge data (`hydrateCards`); false when the badge is hidden. Default true. */
  visa?: boolean;
  /** Load the ghost job marks (`hydrateCards`); only when the check is on. Default false. */
  ghost?: boolean;
}

export interface JobPage {
  jobs: JobCard[];
  total: number;
  /** The page actually returned (after clamping). */
  page: number;
  pageCount: number;
  pageSize: number;
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The job's stated salary reaches `min` per year in the base currency `currency`, read from the normalized range of
 * `salary_json` (never from the raw text): the upper bound, or the lower one of an open-ended range. A salary under
 * review (`qualityStatus = review`) or without a figure in the base currency does not count.
 */
export function annualSalaryAtLeast(min: number, currency: string): SQL {
  return sql`(jsonb_typeof(${jobs.salaryJson}) = 'object' and ${jobs.salaryJson}->>'qualityStatus' is distinct from 'review' and coalesce(${baseBoundSql("max", currency)}, ${baseBoundSql("min", currency)}) >= ${min})`;
}

/**
 * The job states a salary the list can draw on the axis of the base currency `currency`: a readable bound, not under review.
 * The same rule as `listSalary` (lib/dashboard/salary.ts), so "salary stated" counts and the rows agree.
 */
export function hasListableSalary(currency: string): SQL {
  return sql`(jsonb_typeof(${jobs.salaryJson}) = 'object' and ${jobs.salaryJson}->>'qualityStatus' is distinct from 'review' and (${baseBoundSql("min", currency)} is not null or ${baseBoundSql("max", currency)} is not null))`;
}

/** The job has a location whose `city` is one of `members` (the raw `locations_json[].city` values of a city group). */
export function jobHasCityIn(members: readonly string[]): SQL {
  return sql`exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(${jobs.locationsJson}) = 'array' then ${jobs.locationsJson} else '[]'::jsonb end) as loc
      where jsonb_typeof(loc) = 'object' and loc->>'city' in (${sql.join(members.map((member) => sql`${member}`), sql`, `)})
    )`;
}

/**
 * WHERE conditions for the filters; undefined when none apply. `ux`: the seen / closure tables exist (`uxTablesReady`); before the
 * migration "unseen only" has nothing to go by and is ignored.
 */
export function buildJobConditions(db: Executor, filters: JobFilters, timezone: string, latest: LatestScore, ux = true): SQL | undefined {
  const conditions: SQL[] = [];

  const search = jobSearchCondition(filters.search, filters.searchIn);
  if (search) conditions.push(search);
  if (filters.countries?.length) conditions.push(jobHasCountryIn(filters.countries));

  if (filters.sources && filters.sources.length > 0) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(jobSources)
          .innerJoin(channels, eq(channels.id, jobSources.channelId))
          .where(and(eq(jobSources.jobId, jobs.id), inArray(channels.family, [...filters.sources]))),
      ),
    );
  }

  // on `jobs.company_id` alone: Today and the trends do not join the companies table
  if (filters.companyIds !== null && filters.companyIds !== undefined) conditions.push(filters.companyIds.length > 0 ? inArray(jobs.companyId, [...filters.companyIds]) : sql`false`);

  if (filters.cities && filters.cities.length > 0) {
    const members = filters.cityMembers && filters.cityMembers.length > 0 ? filters.cityMembers : filters.cities;
    conditions.push(jobHasCityIn(members));
  }
  if (filters.workplaces && filters.workplaces.length > 0) conditions.push(inArray(jobs.workplace, [...filters.workplaces]));
  if (filters.contracts && filters.contracts.length > 0) conditions.push(inArray(jobs.contract, [...filters.contracts]));
  // The status the job shows (the user's closed / open judgement on top of the automatic one)
  if (filters.statuses && filters.statuses.length > 0) conditions.push(inArray(effectiveStatusSql(ux), [...filters.statuses]));
  if (filters.applicationStatuses && filters.applicationStatuses.length > 0) {
    conditions.push(inArray(sql`coalesce((select ${applications.status} from ${applications} where ${applications.jobId} = ${jobs.id}), 'new')`, [...filters.applicationStatuses]));
  }
  if (filters.minRank !== null && filters.minRank !== undefined) conditions.push(sql`${latest.rankValue} >= ${filters.minRank}`);
  if (filters.minAnnualSalary !== null && filters.minAnnualSalary !== undefined) conditions.push(annualSalaryAtLeast(filters.minAnnualSalary, policyCurrency(filters)));

  if (filters.from) {
    conditions.push(sql`${jobs.firstSeenAt} >= (${filters.from}::date)::timestamp at time zone ${timezone}`);
  }
  if (filters.to) {
    conditions.push(sql`${jobs.firstSeenAt} < ((${filters.to}::date + 1)::timestamp at time zone ${timezone})`);
  }
  if (filters.highValue) conditions.push(hasHighValueSignal(db, filters.highValue));
  if (filters.salaryDisclosed) conditions.push(sql`${jobs.salaryJson} is not null and ${jobs.salaryJson} <> 'null'::jsonb`);
  if (filters.favoritesOnly) conditions.push(exists(db.select({ one: sql`1` }).from(jobFavorites).where(eq(jobFavorites.jobId, jobs.id))));
  if (filters.trap) {
    const trapped = exists(db.select({ one: sql`1` }).from(trapScans).where(and(eq(trapScans.jobId, jobs.id), sql`${trapScans.trapCount} > 0`)));
    conditions.push(filters.trap === "only" ? trapped : not(trapped));
  }
  if (filters.visa) {
    const status = filters.visa === "offered" ? "offered" : "not_offered";
    const found = exists(db.select({ one: sql`1` }).from(jobVisa).where(and(eq(jobVisa.jobId, jobs.id), eq(jobVisa.status, status))));
    conditions.push(filters.visa === "offered" ? found : not(found));
  }
  if (filters.ghost) {
    const ghost = ghostFilterCondition(filters.ghost, jobs.id, ghostTrustedKeys());
    if (ghost) conditions.push(ghost);
  }
  if (filters.unseenOnly && ux) conditions.push(not(seenSql()));
  const german = hideGermanLevels(latest, filters.hideGermanLevels ?? []);
  if (german) conditions.push(german);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * The ORDER BY of /jobs for a sort and a direction. A missing value is last in both directions (never flipped to the top):
 * unscored and hard-filtered jobs under `rank` (filtered ones after the unscored), jobs without a comparable salary under `salary`.
 * Ties fall back to fixed keys ending in the id, so pages never repeat or skip a job. The default (descending) orders are the ones
 * from before the column-head sorts, so old links list the same jobs in the same order.
 *
 * `salary`: the comparable annual figure in the base currency `currency` (`annualBaseFigureSql`: the middle of a range, else the one
 * bound; the detail page's median uses the same figure); a salary marked possibly another region's pay comes after every comparable
 * one; under review, unstated or worked out in another base currency = none.
 */
export function jobOrderBy(sort: JobSort, dir: SortDir, latest: LatestScore, currency: string, lastListed: SQL<Date | null>, filters: Pick<JobFilters, "search" | "searchIn"> = {}): SQL[] {
  const way = sql.raw(dir === "asc" ? "asc" : "desc");
  const filteredLast = sql`coalesce(${latest.filterResult} = 'filtered_out', false) asc`;
  switch (sort) {
    case "relevance":
      if (filters.search?.status === "ok") return [...jobSearchOrderBy(filters.search, filters.searchIn), sql`${latest.rankValue} desc nulls last`, sql`${jobs.postedAt} desc nulls last`, desc(jobs.firstSeenAt), desc(jobs.id)];
      return jobOrderBy("rank", "desc", latest, currency, lastListed);

    case "last_listed":
      return [sql`${lastListed} ${way} nulls last`, sql`${jobs.id} ${way}`];
    case "rank":
      return [filteredLast, sql`${latest.rankValue} ${way} nulls last`, sql`${jobs.postedAt} desc nulls last`, desc(jobs.firstSeenAt), desc(jobs.id)];
    case "posted":
      return [sql`${jobs.postedAt} ${way} nulls last`, desc(jobs.firstSeenAt), desc(jobs.id)];
    case "first_seen":
      return [sql`${jobs.firstSeenAt} ${way}`, sql`${jobs.id} ${way}`];
    case "salary": {
      const figure = annualBaseFigureSql(currency);
      const comparable = sql`(case when ${comparableSalaryWhere} then ${figure} end) ${way} nulls last`;
      // what is left with a figure is the "possibly another region's pay" (review / unstated have none)
      const otherRegion = sql`(case when jsonb_typeof(${jobs.salaryJson}) = 'object' and ${jobs.salaryJson}->>'qualityStatus' is distinct from 'review' then ${figure} end) ${way} nulls last`;
      return [comparable, otherRegion, sql`${latest.rankValue} desc nulls last`, desc(jobs.firstSeenAt), desc(jobs.id)];
    }
  }
}

/**
 * The WHERE of /jobs: hard-filtered jobs stay hidden unless asked for; explicit scope intersects every filter, including status.
 * Absent scope keeps the legacy rule: current without statuses, all with statuses. Future search matching belongs in
 * buildJobConditions, without changing this scope composition. One definition for the list, counts, "mark all seen" and
 * the job counts of the company drop-down (`listCompanyFilterOptions`, with no filters: the list as /jobs opens).
 */
export async function jobListWhere(db: Executor, filters: JobFilters, timezone: string, latest: LatestScore, ux: boolean): Promise<SQL | undefined> {
  const hideFiltered = filters.filteredOnly
    ? eq(latest.filterResult, "filtered_out")
    : filters.includeFiltered
      ? undefined
      : or(isNull(latest.filterResult), ne(latest.filterResult, "filtered_out"));
  const dormant = await dormancyReady(db);
  const scope = jobScopeSql(resolveJobScope(filters.scope, filters.statuses), ux, dormant);
  const reasons = archiveReasonSql(filters.closedReasons ?? [], ux, dormant);
  const relisted = filters.relistedSince && await listingReady(db) ? sql`${jobs.relistedAt} >= ${filters.relistedSince.toISOString()}::timestamptz` : undefined;
  return and(buildJobConditions(db, filters, timezone, latest, ux), hideFiltered, scope, reasons, relisted);
}

/** A `searchIn=all` query ran past job-search.yaml `query.all_scope_timeout_ms` and Postgres cancelled it. */
export class SearchTimeoutError extends Error {
  readonly code = "search_timeout";
  constructor() {
    super("full-text search timed out");
    this.name = "SearchTimeoutError";
  }
}

const QUERY_CANCELED = "57014";

function isStatementTimeout(error: unknown): boolean {
  // drizzle wraps the driver error; postgres.js puts the SQLSTATE in `code`
  for (let current = error, depth = 0; current instanceof Object && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    if ((current as { code?: unknown }).code === QUERY_CANCELED) return true;
  }
  return false;
}

/**
 * Searching descriptions and translations scans every row with a regex, so those queries run in one transaction under a
 * statement time limit (SET LOCAL: it ends with the transaction, also on pooled connections). Other queries run as they are.
 */
async function withSearchTimeout<T>(db: Db, filters: JobFilters, run: (q: Executor) => Promise<T>): Promise<T> {
  const plan = filters.search;
  if (filters.searchIn !== "all" || plan?.status !== "ok") return run(db);
  const timeout = `${z.number().int().positive().parse(plan.allScopeTimeoutMs)}ms`;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${timeout}, true)`);
      return run(tx);
    });
  } catch (error) {
    if (isStatementTimeout(error)) throw new SearchTimeoutError();
    throw error;
  }
}

/** How many jobs /jobs holds under filters; the archive switch replaces only scope, retaining all other filters. */
export async function countJobList(db: Db, options: { filters: JobFilters; timezone: string }): Promise<number> {
  return withSearchTimeout(db, options.filters, (q) => countJobListIn(q, options));
}

async function countJobListIn(db: Executor, options: { filters: JobFilters; timezone: string }): Promise<number> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const [row] = await db
    .with(latest)
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(await jobListWhere(db, options.filters, options.timezone, latest, ux));
  return row?.count ?? 0;
}

/** All jobs with filters, search, sort and server-side pagination. */
export async function listJobs(db: Db, options: ListJobsOptions): Promise<JobPage> {
  return withSearchTimeout(db, options.filters, (q) => listJobsIn(q, options));
}

async function listJobsIn(db: Executor, options: ListJobsOptions): Promise<JobPage> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const where = await jobListWhere(db, options.filters, options.timezone, latest, ux);
  const pageSize = Math.max(1, options.pageSize);
  let page = Math.max(1, Math.floor(options.page));

  const orderBy = jobOrderBy(options.sort, options.dir ?? DEFAULT_SORT_DIR[options.sort], latest, policyCurrency(options.filters), lastListedSql(await listingReady(db)), options.filters);

  // Count, sort and paginate ids before evaluating card columns and their subqueries. PostgreSQL also
  // inlines this single-use CTE and prunes its unused wide score columns (covered by EXPLAIN tests).
  const selectIds = (page: number) => db
    .with(latest)
    .select({ id: jobs.id, total: sql<number>`count(*) over ()`.mapWith(Number) })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  let ids = await selectIds(page);
  let total = ids[0]?.total ?? 0;
  let pageCount = Math.max(1, Math.ceil(total / pageSize));
  // An empty page has no window count. Only stale page numbers need a separate count and retry.
  if (ids.length === 0 && page > 1) {
    const [countRow] = await db
      .with(latest)
      .select({ total: count() })
      .from(jobs)
      .innerJoin(companies, eq(companies.id, jobs.companyId))
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(where);
    total = countRow?.total ?? 0;
    pageCount = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, pageCount);
    ids = await selectIds(page);
  }

  const cardScore = latestScoreLateral(db);
  const cards: CardRow[] = ids.length === 0 ? [] : await db
    .select(cardColumns(cardScore, ux, await dormancyReady(db), await listingReady(db)))
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoinLateral(cardScore, sql`true`)
    .where(inArray(jobs.id, ids.map(({ id }) => id)));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const rows = ids.flatMap(({ id }) => {
    const card = cardsById.get(id);
    return card ? [card] : [];
  });

  return { jobs: await hydrateCards(db, rows, { visa: options.visa ?? true, ghost: options.ghost === true }), total, page, pageCount, pageSize };
}

/** What the "seen" controls of /jobs need about the whole filtered list (every page): how many are unseen, and how many were first seen after `since`. */
export interface JobListSeenCounts {
  unseen: number;
  /** First seen after `since` (the "new since your last visit" marker); 0 without a marker. */
  newSince: number;
}

export async function countJobListSeen(db: Db, options: { filters: JobFilters; timezone: string; since: Date | null }): Promise<JobListSeenCounts> {
  return withSearchTimeout(db, options.filters, (q) => countJobListSeenIn(q, options));
}

async function countJobListSeenIn(db: Executor, options: { filters: JobFilters; timezone: string; since: Date | null }): Promise<JobListSeenCounts> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const since = options.since ? sql`${jobs.firstSeenAt} > ${options.since.toISOString()}::timestamptz` : sql`false`;
  const [row] = await db
    .with(latest)
    .select({
      unseen: (ux ? sql<number>`count(*) filter (where not ${seenSql()})` : sql<number>`0`).mapWith(Number),
      newSince: sql<number>`count(*) filter (where ${since})`.mapWith(Number),
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(await jobListWhere(db, options.filters, options.timezone, latest, ux));
  return { unseen: row?.unseen ?? 0, newSince: row?.newSince ?? 0 };
}

/** The ids of every unseen job of the filtered /jobs list (all pages): what "mark all seen" marks. */
export async function listUnseenJobIds(db: Db, options: { filters: JobFilters; timezone: string; firstSeenUpTo?: Date }): Promise<number[]> {
  return withSearchTimeout(db, options.filters, (q) => listUnseenJobIdsIn(q, options));
}

async function listUnseenJobIdsIn(db: Executor, options: { filters: JobFilters; timezone: string; firstSeenUpTo?: Date }): Promise<number[]> {
  const latest = latestScoreCte(db);
  if (!(await uxTablesReady(db))) return [];
  const rows = await db
    .with(latest)
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(
      and(
        await jobListWhere(db, options.filters, options.timezone, latest, true),
        not(seenSql()),
        // Only jobs that were already there when the page was drawn (one that arrived since was never on screen)
        options.firstSeenUpTo ? lte(jobs.firstSeenAt, options.firstSeenUpTo) : undefined,
      ),
    );
  return rows.map((row) => row.id);
}

export interface JobCountryOption {
  code: string;
  jobCount: number;
}

/** One group-by for the chosen scope, counting each job once per code. Retain absent selections with count zero. */
export async function listJobCountryOptions(db: Db, options: { scope?: JobScope | null; selected?: readonly string[]; timezone: string }): Promise<JobCountryOption[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const code = sql<string>`upper(loc->>'countryCode')`;
  const rows = await db.with(latest).select({ code, jobCount: sql<number>`count(distinct ${jobs.id})`.mapWith(Number) })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .innerJoin(sql`lateral ${jobLocationRows()}`, sql`true`)
    .where(and(await jobListWhere(db, { scope: options.scope }, options.timezone, latest, ux), sql`jsonb_typeof(loc) = 'object'`, sql`${code} ~ '^[A-Z]{2}$'`))
    .groupBy(code)
    .orderBy(code);
  const counts = new Map(rows.map((row) => [row.code, row.jobCount]));
  for (const selected of options.selected ?? []) if (!counts.has(selected.toUpperCase())) counts.set(selected.toUpperCase(), 0);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, jobCount]) => ({ code, jobCount }));
}

/** A company of the company drop-down: its display name (the value of the filter) and how many jobs the unfiltered /jobs list holds of it. */
export interface CompanyFilterOption {
  name: string;
  jobCount: number;
}

/**
 * The companies of the company drop-down: those with jobs in the /jobs list as it opens (`jobListWhere` without filters: no
 * hard-filtered and no closed jobs), most jobs first, then by name; at most `limit`. Rows with the same display name are one option
 * (the filter picks both). A name longer than a filter value may be is left out: the URL would drop it.
 */
export async function listCompanyFilterOptions(db: Db, options: { limit: number; timezone: string }): Promise<CompanyFilterOption[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const jobCount = sql<number>`count(*)`.mapWith(Number);
  const rows = await db
    .with(latest)
    .select({ name: companies.name, jobCount })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .where(and(await jobListWhere(db, {}, options.timezone, latest, ux), sql`char_length(${companies.name}) <= ${MAX_FILTER_VALUE_CHARS}`, sql`btrim(${companies.name}) <> ''`))
    .groupBy(companies.name)
    .orderBy(desc(jobCount), asc(companies.name))
    .limit(Math.max(1, options.limit));
  return rows;
}

