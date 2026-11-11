import type { LoaderInput } from "nuqs/server";
import { loadCompaniesSearchParams } from "./search-params";
import { companyOverviewDependencies, loadCompanyOverviewParams, type CompanyOverviewDependencies, type CompanyOverview } from "./overview-data";

export { companyOverviewDependencies, loadCompanyOverviewParams, type CompanyOverviewDependencies, type CompanyOverviewSettings, type CompanyOverviewItem, type CompanyOverview } from "./overview-data";

/** The web URL adapter delegates all query and mark assembly to the plain-parameter reader. */
export async function loadCompanyOverview(searchParams: LoaderInput | Promise<LoaderInput>, deps: CompanyOverviewDependencies = companyOverviewDependencies): Promise<CompanyOverview> {
  return loadCompanyOverviewParams(loadCompaniesSearchParams(await searchParams), deps);
}
