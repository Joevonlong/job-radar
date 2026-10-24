import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { QuickFilter } from "@/components/jobs/quick-filter";
import { FilterBar } from "@/components/jobs/filter-bar";
import { FilteredToggle } from "@/components/jobs/filtered-toggle";
import { JobList } from "@/components/jobs/job-list";
import { KeyHints } from "@/components/jobs/key-hints";
import { MarkSeenButton } from "@/components/jobs/mark-seen-button";
import { SaveViewButton } from "@/components/jobs/save-view-button";
import { Pagination } from "@/components/jobs/pagination";
import { toListItems } from "@/components/jobs/to-list-items";
import { VisitTracker } from "@/components/jobs/visit-tracker";
import { readHiddenSettings } from "@/lib/applications/hidden";
import { loadConfig } from "@/lib/config";
import { PageHeader } from "@/components/shell/page-header";
import { JOBS_PAGE_SIZE } from "@/lib/dashboard/constants";
import { getSchedule } from "@/lib/dashboard/context";
import { loadListViz } from "@/lib/dashboard/list-viz";
import { NewSinceVisitNote } from "@/components/jobs/new-since-visit-note";
import { loadHighValuePolicy, loadSignalCatalog } from "@/lib/signals/floor";
import { countJobList, countJobListSeen, getDb, getFilterFloors, getJobFilterOptions, getVisitState, hasHighValueCategories, listCompanyFilterOptions, listCompanyMatchRows, listJobs, listMonthSalaryFigures } from "@/lib/db";
import { loadPipeline } from "@/lib/market/effective";
import { canonicalCompanyNames } from "@/lib/pipeline/company";
import { loadCityGroups } from "@/lib/jobs/cities";
import { jobsListFilters } from "@/lib/jobs/list-filters";
import { hasActiveFilters, type FilterVisibility, jobsListHref, jobsSearchQuery, loadJobsSearchParams, withLegacyKeys } from "@/lib/jobs/search-params";
import { salaryFilteredIds } from "@/lib/jobs/filter-floors";
import { effectiveDir, nextSortParams } from "@/lib/jobs/sort";
import { effectiveSeenUpTo } from "@/lib/jobs/visit";
import { trapsEnabled } from "@/lib/traps/settings";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import { visaFilterAvailable } from "@/lib/visa/filter";
import { VisibilityScope } from "@/components/applications/visibility-scope";
import { loadBaseCurrency } from "@/lib/signals/floor";

const CLOSED_VIEW = ["closed", "possibly_closed"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.jobs");
  return { title: t("title") };
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // `?t12=true` (the old name of `high`) reads as `high=true`; links written from here only carry `high`
  const params = withLegacyKeys(await loadJobsSearchParams(searchParams));
  const [t, tJobs, tFav, tFavPage, tSeen, locale, tClosed] = await Promise.all([
    getTranslations("pages.jobs"),
    getTranslations("dashboard.jobs"),
    getTranslations("favorites.filter"),
    getTranslations("favorites.page"),
    getTranslations("dashboard.seen"),
    getLocale(),
    getTranslations("dashboard.closed"),
  ]);
  const highValue = loadHighValuePolicy();
  const catalog = loadSignalCatalog();
  const highValueNames = catalog && hasHighValueCategories(highValue) ? catalog.highValueIds.map((id) => catalog.labelOf(id, locale)) : [];

  const hidden = readHiddenSettings();
  const { timezone } = getSchedule();
  const now = new Date();
  const db = getDb();
  // a company written another way than it is stored (`zalando`, an alias) reads as its display name, so the drop-down shows it ticked
  if (params.company.length > 0) {
    const canonical = canonicalCompanyNames(await listCompanyMatchRows(db), params.company, loadPipeline());
    if (canonical.length !== params.company.length || canonical.some((name, index) => name !== params.company[index])) redirect(jobsListHref({ ...params, company: canonical }));
  }
  const ui = loadConfig("ui");
  const cities = await loadCityGroups(db);
  // hidden, a `visa=` in the URL is ignored but kept (no control, no chip, not counted); read once for the filter, the list
  // query and the badges
  const visaFilter = await visaFilterAvailable(db);
  // the same for the ghost job check (ui.yaml job_checks.ghost): off, no control, no chip, no mark, and `ghost=` filters nothing
  const ghostFilter = await ghostFilterAvailable(db);
  const filters = await jobsListFilters(db, params, { cities, visa: visaFilter, ghost: ghostFilter });
  const visibility: FilterVisibility = { ignore: [...(visaFilter ? [] : (["visa"] as const)), ...(ghostFilter ? [] : (["ghost"] as const))] };
  const visit = await getVisitState(db);
  const seenUpTo = effectiveSeenUpTo(visit, now);
  // "Closed (N)" is the status filter "closed + possibly closed" (no URL key of its own); N counts the list it opens
  const closedView = params.status.length === CLOSED_VIEW.length && CLOSED_VIEW.every((status) => params.status.includes(status));
  const [result, options, seenCounts, salaryFigures, closedCount, companies] = await Promise.all([
    listJobs(db, {
      filters,
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      pageSize: JOBS_PAGE_SIZE,
      timezone,
      visa: visaFilter,
      ghost: ghostFilter,
    }),
    getJobFilterOptions(db),
    countJobListSeen(db, { filters, timezone, since: seenUpTo }),
    listMonthSalaryFigures(db, { now, timeZone: timezone, currency: loadBaseCurrency() ?? "" }),
    countJobList(db, { filters: { ...filters, statuses: CLOSED_VIEW }, timezone }),
    listCompanyFilterOptions(db, { limit: ui.filters.company_options_max, timezone }),
  ]);
  const filterFloors = await getFilterFloors(db, salaryFilteredIds(result.jobs));
  const items = await toListItems(result.jobs, { now, timezone, filterFloors, seenUpTo, visa: visaFilter, ghost: ghostFilter, monthSalaries: { figures: salaryFigures, minSample: ui.salary_stats.min_sample } });
  // The "new since your last visit" divider when the list runs newest first (it sits on the page of the boundary only);
  // any other order says it next to the count, with a link to that order
  const newestFirst = params.sort === "first_seen" && effectiveDir(params.sort, params.dir) === "desc";
  const lastNewIndex = items.findLastIndex((item) => item.isNew === true);
  const lastNew = items[lastNewIndex];
  // only on the page where the new jobs end: its last new job is the newSince-th of the whole list (a page that is all new, with
  // more new jobs on the next page, draws none)
  const boundaryOnPage =
    lastNew !== undefined &&
    (result.page - 1) * JOBS_PAGE_SIZE + lastNewIndex + 1 === seenCounts.newSince &&
    (lastNewIndex < items.length - 1 || result.page < result.pageCount);
  const newDivider = newestFirst && boundaryOnPage ? { afterJobId: lastNew.id, count: seenCounts.newSince } : undefined;
  // The column heads sort; each head links to the list sorted by it (the current one flips its direction)
  const sortHref = (column: "score" | "salary" | "fresh") => jobsListHref({ ...params, ...nextSortParams(column, params) });
  const sortHead = { sort: params.sort, dir: effectiveDir(params.sort, params.dir), hrefs: { score: sortHref("score"), salary: sortHref("salary"), fresh: sortHref("fresh") } };

  return (
    <VisibilityScope>
    <div data-wide className="flex min-w-0 flex-col gap-sp-4">
      <VisitTracker />
      <PageHeader title={t("title")} description={t("description")} />
      <FilterBar options={{ ...options, cities: cities.map(({ key, target }) => ({ key, target })), companies, companyOptionsMax: ui.filters.company_options_max, companyOptionsVisible: ui.filters.company_options_visible, traps: trapsEnabled(), visa: visaFilter, ghost: ghostFilter, hiddenWorkplaces: hidden.workplaces, hiddenContracts: hidden.contracts, highValueNames }} />
      <div className="flex flex-wrap items-center gap-x-sp-3 gap-y-sp-2">
        {params.filteredOnly === true ? (
          <FilteredToggle active only href={jobsListHref({ ...params, filteredOnly: null, page: 1 })} />
        ) : (
          <FilteredToggle active={params.filtered === true} href={jobsListHref({ ...params, filtered: params.filtered === true ? null : true, page: 1 })} />
        )}
        <QuickFilter
          active={params.fav === true}
          href={jobsListHref({ ...params, fav: params.fav === true ? null : true, page: 1 })}
          offLabel={tFav("off")}
          onLabel={tFav("on")}
          removeLabel={tFav("remove")}
          testId="toggle-fav"
        />
        <QuickFilter
          active={params.unseen === true}
          href={jobsListHref({ ...params, unseen: params.unseen === true ? null : true, page: 1 })}
          offLabel={tSeen("filterOff")}
          onLabel={tSeen("filterOn")}
          removeLabel={tSeen("filterRemove")}
          testId="toggle-unseen"
        />
        <QuickFilter
          active={closedView}
          href={jobsListHref({ ...params, status: closedView ? null : [...CLOSED_VIEW], page: 1 })}
          offLabel={tClosed("filter", { count: closedCount })}
          onLabel={tClosed("filter", { count: closedCount })}
          removeLabel={tClosed("filterRemove")}
          testId="toggle-closed"
        />
        <SaveViewButton />
        <span className="font-mono text-data text-ink-2" role="status" data-testid="result-count">
          {tJobs("count", { count: result.total })}
        </span>
        <MarkSeenButton count={seenCounts.unseen} target={{ scope: "jobs", query: jobsSearchQuery(params), renderedAt: now.toISOString() }} />
        {!newestFirst && seenCounts.newSince > 0 ? <NewSinceVisitNote count={seenCounts.newSince} href={jobsListHref({ ...params, sort: "first_seen", dir: null, page: 1 })} /> : null}
      </div>
      <JobList
        jobs={items}
        label={tJobs("listLabel")}
        empty={
          // "only favorites" and nothing else narrowing the list: no star yet, so say how to star a job instead of "relax the filters"
          params.fav === true && !hasActiveFilters({ ...params, fav: null }, visibility) ? (
            <span data-testid="jobs-fav-empty">
              {tFavPage("empty")}{" "}
              <Link href={jobsListHref({ ...params, fav: null, page: 1 })} className="text-foreground font-medium underline underline-offset-2">
                {tFav("remove")} →
              </Link>
            </span>
          ) : hasActiveFilters(params, visibility) ? (
            tJobs("emptyFiltered")
          ) : (
            tJobs("empty")
          )
        }
        viz={loadListViz(now, timezone)}
        sortHead={sortHead}
        {...(newDivider ? { newDivider } : {})}
      />
      <Pagination page={result.page} pageCount={result.pageCount} hrefFor={(page) => jobsListHref({ ...params, page })} />
      <KeyHints />
    </div>
    </VisibilityScope>
  );
}
