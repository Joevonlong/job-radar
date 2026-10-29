/** The /jobs URL state -> the list query's filters (server only): the page and its "mark all seen" action read the list the same way. */
import { loadConfig } from "@/lib/config";
import { listingReady } from "@/lib/db/repos/listing";
import { germanLevelsToHide } from "@/lib/dashboard/german";
import { hasHighValueCategories, type Db, type JobFilters } from "@/lib/db";
import { viewFiltersFromParams } from "@/lib/interests/view-filters";
import { loadBaseCurrency, loadHighValuePolicy } from "@/lib/signals/floor";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import type { CompanyMatchIndex } from "@/lib/pipeline/company";
import { visaFilterAvailable } from "@/lib/visa/filter";

import { loadCityGroups } from "./cities";
import type { CityGroup } from "./city-groups";
import { resolveViewCompanyIds, toJobFilters } from "./job-filters";
import type { FilterVisibility, JobsSearchParams } from "./search-params";

/**
 * The filters of `/jobs?<params>`; `cities` = the city groups and `visa` = `visaFilterAvailable` / `ghost` =
 * `ghostFilterAvailable` when the caller already has them; `companyIndex` reuses its company lookup.
 */
export async function jobsListFilters(db: Db, params: JobsSearchParams, known: { cities?: readonly CityGroup[]; visa?: boolean; ghost?: boolean; companyIndex?: CompanyMatchIndex; listing?: boolean; now?: Date; badgeDays?: number } = {}): Promise<JobFilters> {
  const highValue = loadHighValuePolicy();
  const view = viewFiltersFromParams(params);
  const [companyIds] = await resolveViewCompanyIds(db, [view], { index: known.companyIndex });
  return {
    ...toJobFilters(view, { cityGroups: known.cities ?? (await loadCityGroups(db)), visa: known.visa ?? (await visaFilterAvailable(db)), ghost: known.ghost ?? (await ghostFilterAvailable(db)), companyIds }),
    from: params.from,
    to: params.to,
    // URL-only scope and reasons never pass through saved-view conversion. Mark-all-seen shares this mapping.
    scope: params.scope,
    relistedSince: params.relisted === true && (known.listing ?? await listingReady(db))
      ? new Date((known.now ?? new Date()).getTime() - (known.badgeDays ?? loadConfig("jobArchive").relist.badge_days) * 86_400_000) : null,
    closedReasons: params.reason,
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

/** The page can compose this with the visa/ghost ignore list during the migration window. */
export function relistFilterVisibility(ready: boolean): FilterVisibility {
  return { ignore: ready ? [] : ["relisted"] };
}
