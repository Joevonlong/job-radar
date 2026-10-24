import type { LoaderInput } from "nuqs/server";

import { loadConfig, type PipelineConfig } from "@/lib/config";
import { getDb, listCompanyOverview, type CompanyOverviewOptions, type CompanyOverviewPage, type CompanyOverviewRow } from "@/lib/db";
import { MAX_COMPANY_NAME_CHARS } from "@/lib/interests/service";
import { companyJobsHref } from "@/lib/jobs/company-link";
import { loadPipeline } from "@/lib/market";
import { resolveCompanyName } from "@/lib/pipeline/company";

import { buildBlacklistedCompanyKeys, buildWatchedCompanyKeys, isCompanyExcluded, isCompanyWatched, watchedEntriesFor } from "./marks";
import { loadCompaniesSearchParams, type CompaniesSearchParams } from "./search-params";

export interface CompanyOverviewSettings {
  pageSize: number;
  timezone: string;
  pipeline: PipelineConfig;
  watchedCompanies: readonly string[];
  excludedCompanies: readonly string[];
}

export interface CompanyOverviewDependencies {
  loadSettings: () => CompanyOverviewSettings;
  list: (options: CompanyOverviewOptions) => Promise<CompanyOverviewPage>;
}

export interface CompanyOverviewItem extends CompanyOverviewRow {
  watchedEntries: string[];
  watchedByFlagOnly: boolean;
  companyFlagWatched: boolean;
  watchable: boolean;
  excluded: boolean;
  href: string | null;
}

export interface CompanyOverview extends Omit<CompanyOverviewPage, "rows"> {
  rows: CompanyOverviewItem[];
  params: CompaniesSearchParams;
  pageSize: number;
  excludedCount: number;
}

const dependencies: CompanyOverviewDependencies = {
  loadSettings: () => ({
    pageSize: loadConfig("ui").companies.page_size,
    timezone: loadConfig("schedule").timezone,
    pipeline: loadPipeline(),
    watchedCompanies: loadConfig("interests").watched_companies,
    excludedCompanies: loadConfig("preferences").exclude_companies,
  }),
  list: (options) => listCompanyOverview(getDb(), options),
};

/** Server loader: read current settings, query the page, then apply the same marks as push and the hard filter. */
export async function loadCompanyOverview(searchParams: LoaderInput | Promise<LoaderInput>, deps: CompanyOverviewDependencies = dependencies): Promise<CompanyOverview> {
  const params = loadCompaniesSearchParams(await searchParams);
  const { pageSize, timezone, pipeline, watchedCompanies, excludedCompanies } = deps.loadSettings();
  const overview = await deps.list({ ...params, pageSize, timezone });
  const watchedKeys = buildWatchedCompanyKeys(watchedCompanies, pipeline);
  const blacklistedKeys = buildBlacklistedCompanyKeys(excludedCompanies, pipeline);
  const rows = overview.rows.map((row): CompanyOverviewItem => {
    const watchedEntries = watchedEntriesFor(row, watchedCompanies, pipeline);
    return {
      ...row,
      watched: isCompanyWatched(row, watchedKeys),
      watchedEntries,
      watchedByFlagOnly: row.watched && watchedEntries.length === 0,
      companyFlagWatched: row.watched,
      watchable: row.name.length <= MAX_COMPANY_NAME_CHARS && resolveCompanyName(row.name, pipeline).nameNorm === row.nameNorm,
      excluded: isCompanyExcluded(row, blacklistedKeys, pipeline.company.legal_suffixes),
      href: companyJobsHref(row.name),
    };
  });
  return { ...overview, rows, params: { ...params, page: overview.page }, pageSize, excludedCount: excludedCompanies.length };
}
