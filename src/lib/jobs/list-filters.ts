/** The /jobs URL state -> the list query's filters (server only): the page and its "mark all seen" action read the list the same way. */
import { germanLevelsToHide } from "@/lib/dashboard/german";
import { hasHighValueCategories, type Db, type JobFilters } from "@/lib/db";
import { viewFiltersFromParams } from "@/lib/interests/view-filters";
import { loadBaseCurrency, loadHighValuePolicy } from "@/lib/signals/floor";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import { visaFilterAvailable } from "@/lib/visa/filter";

import { loadCityGroups } from "./cities";
import type { CityGroup } from "./city-groups";
import { resolveViewCompanyIds, toJobFilters } from "./job-filters";
import type { JobsSearchParams } from "./search-params";

/**
 * The filters of `/jobs?<params>`; `cities` = the city groups and `visa` = `visaFilterAvailable` / `ghost` =
 * `ghostFilterAvailable` when the caller already has them.
 */
export async function jobsListFilters(db: Db, params: JobsSearchParams, known: { cities?: readonly CityGroup[]; visa?: boolean; ghost?: boolean } = {}): Promise<JobFilters> {
  const highValue = loadHighValuePolicy();
  const view = viewFiltersFromParams(params);
  const [companyIds] = await resolveViewCompanyIds(db, [view]);
  return {
    ...toJobFilters(view, { cityGroups: known.cities ?? (await loadCityGroups(db)), visa: known.visa ?? (await visaFilterAvailable(db)), ghost: known.ghost ?? (await ghostFilterAvailable(db)), companyIds }),
    from: params.from,
    to: params.to,
    includeFiltered: params.filtered,
    filteredOnly: params.filteredOnly === true,
    hideGermanLevels: params.hideLang ? germanLevelsToHide() : null,
    // without any high-value category the filter has nothing to keep (its button is hidden): ignored
    highValue: params.high === true && hasHighValueCategories(highValue) ? highValue : null,
    favoritesOnly: params.fav === true,
    unseenOnly: params.unseen === true,
    // the salary filter and the salary sort compare in the market's base currency (left out, they would assume EUR)
    baseCurrency: loadBaseCurrency(),
  };
}
