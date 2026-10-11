/** The last-days trend of every saved view for /interests (server only). */
import type { Db } from "@/lib/db";
import { getViewDailyCounts, hasHighValueCategories, type HighValuePolicy, type ViewTrendInput } from "@/lib/db";
import { germanLevelsToHide } from "@/lib/dashboard/german";
import type { SavedView } from "@/lib/config/schemas/interests";
import { loadCityGroups } from "@/lib/jobs/cities";
import type { CityGroup } from "@/lib/jobs/city-groups";
import { toJobFilters } from "@/lib/jobs/job-filters";
import { loadHighValuePolicy } from "@/lib/signals/floor";
import { visaFilterAvailable } from "@/lib/visa/filter";

/** A saved view's filters in the form the job queries take, the way Today applies them (the dates of a view are ignored there). */
export function viewTrendInput(view: SavedView, context: { cityGroups: readonly CityGroup[] | null; hideGermanLevels: readonly string[]; highValue: HighValuePolicy; visa?: boolean }): ViewTrendInput {
  const f = view.filters;
  return {
    id: view.id,
    filters: {
      ...toJobFilters(f, { cityGroups: context.cityGroups, visa: context.visa === true }),
      includeFiltered: f.filtered === true,
      hideGermanLevels: f.hideLang === true ? context.hideGermanLevels : null,
      // without any high-value category the toggle has nothing to keep (its button is hidden): it filters nothing
      highValue: f.high === true && hasHighValueCategories(context.highValue) ? context.highValue : null,
    },
  };
}

/** New jobs per day over the last `days` days for each view, by view id (oldest first). Empty when the database cannot be read. */
export async function loadViewTrends(db: Db, views: readonly SavedView[], options: { timezone: string; now: Date; days: number }): Promise<Map<string, number[]>> {
  if (views.length === 0) return new Map();
  try {
    const context = { cityGroups: await loadCityGroups(db), hideGermanLevels: germanLevelsToHide(), highValue: loadHighValuePolicy(), visa: await visaFilterAvailable(db) };
    return await getViewDailyCounts(db, { views: views.map((view) => viewTrendInput(view, context)), timezone: options.timezone, now: options.now, days: options.days });
  } catch {
    return new Map();
  }
}
