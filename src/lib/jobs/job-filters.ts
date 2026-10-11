/** Saved-view filters -> the job queries' filters, in one place (server only): /jobs, Today and the view trends all go through it. */
import type { ViewFilters } from "@/lib/config/schemas/interests";
import type { TodayExtraFilters } from "@/lib/db";
import { filterValues } from "@/lib/interests/view-filters";
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

/**
 * The categorical and numeric part of a set of view filters as the job queries take it (what Today's `extra` takes).
 * Dates and toggles stay with the caller. A city may be a group (a metro area): the query gets the union of the members of
 * all picked cities. `cityGroups` may be null when no city is picked.
 */
export function toJobFilters(filters: ViewFilters, context: { cityGroups: readonly CityGroup[] | null }): TodayExtraFilters {
  const cities = filterValues(filters, "city");
  const members = context.cityGroups ? [...new Set(cities.flatMap((city) => cityMembers(context.cityGroups ?? [], city)))] : [];
  return {
    q: filters.q ?? null,
    qLocationTerms: searchLocationTerms(filters.q),
    sources: orNull(filterValues(filters, "source")),
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
  };
}
