/** Saved-view filters -> the job queries' filters, in one place (server only): /jobs, Today and the view trends all go through it. */
import type { ViewFilters } from "@/lib/config/schemas/interests";
import type { TodayExtraFilters } from "@/lib/db";
import { listCompanyMatchRows, type Db } from "@/lib/db";
import { filterValues } from "@/lib/interests/view-filters";
import { loadPipeline } from "@/lib/market/effective";
import { matchCompanyIds } from "@/lib/pipeline/company";
import { trapsEnabled } from "@/lib/traps/settings";

import { searchLocationTerms } from "./cities";
import { cityMembers, type CityGroup } from "./city-groups";

function orNull<T>(values: readonly T[]): readonly T[] | null {
  return values.length > 0 ? values : null;
}

/** Whether `filters` needs the city groups (any city picked): load them only then. */
export function needsCityGroups(filters: ViewFilters): boolean {
  return filterValues(filters, "city").length > 0;
}

/** Whether `filters` picks companies: their ids have to be resolved (`resolveViewCompanyIds`) before `toJobFilters`. */
export function needsCompanyIds(filters: ViewFilters): boolean {
  return filterValues(filters, "company").length > 0;
}

/**
 * The company ids each of `filterSets` picks, in order (null where it picks no company), reading the companies table once however
 * many sets there are (Today resolves the shown view and every tab).
 */
export async function resolveViewCompanyIds(db: Db, filterSets: readonly ViewFilters[]): Promise<(number[] | null)[]> {
  if (!filterSets.some(needsCompanyIds)) return filterSets.map(() => null);
  const rows = await listCompanyMatchRows(db);
  const pipeline = loadPipeline();
  return filterSets.map((filters) => (needsCompanyIds(filters) ? matchCompanyIds(rows, filterValues(filters, "company"), pipeline) : null));
}

/**
 * The categorical and numeric part of a set of view filters as the job queries take it (what Today's `extra` takes).
 * Dates and toggles stay with the caller. A city may be a group (a metro area): the query gets the union of the members of
 * all picked cities. `cityGroups` may be null when no city is picked. `visa`: the visa filter shows and its table exists
 * (`visaFilterAvailable`); otherwise a saved `visa` value is ignored (and kept in the URL / view). `ghost`: the same for the ghost job
 * check (`ghostFilterAvailable`); `ghost: "all"` is no filter. `companyIds`: what the view's companies resolve to
 * (`resolveViewCompanyIds`); absent while the view picks companies, nothing matches (the names are never matched here).
 */
export function toJobFilters(filters: ViewFilters, context: { cityGroups: readonly CityGroup[] | null; visa?: boolean; ghost?: boolean; companyIds?: readonly number[] | null }): TodayExtraFilters {
  const cities = filterValues(filters, "city");
  const members = context.cityGroups ? [...new Set(cities.flatMap((city) => cityMembers(context.cityGroups ?? [], city)))] : [];
  return {
    q: filters.q ?? null,
    qLocationTerms: searchLocationTerms(filters.q),
    sources: orNull(filterValues(filters, "source")),
    companyIds: needsCompanyIds(filters) ? (context.companyIds ?? []) : null,
    cities: orNull(cities),
    cityMembers: orNull(members),
    workplaces: orNull(filterValues(filters, "workplace")),
    contracts: orNull(filterValues(filters, "contract")),
    statuses: orNull(filterValues(filters, "status")),
    applicationStatuses: orNull(filterValues(filters, "app")),
    minRank: filters.minScore ?? null,
    minAnnualSalary: filters.minSalary ?? null,
    salaryDisclosed: filters.salary === true,
    // With traps.yaml off the pages show no trap, so a saved trap filter does nothing either
    trap: filters.trap !== undefined && trapsEnabled() ? filters.trap : null,
    visa: filters.visa !== undefined && context.visa === true ? filters.visa : null,
    ghost: filters.ghost !== undefined && filters.ghost !== "all" && context.ghost === true ? filters.ghost : null,
  };
}
