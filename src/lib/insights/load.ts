/** Reads everything /insights shows (server only): the config, the aggregates, and the view model. */
import { reloadConfig } from "@/lib/config";
import { cityMembers } from "@/lib/jobs/city-groups";
import { loadCityGroups } from "@/lib/jobs/cities";
import { getDb, getDbNow, getInsightsData } from "@/lib/db";
import { buildCatalog, toCategoryViews } from "@/lib/signals/catalog";
import { highValuePolicy } from "@/lib/signals/bonus";
import { loadBaseCurrency, loadSalaryFloor } from "@/lib/signals/floor";

import { dayInZone, previousWindow, resolveRangeDays, windowEnding } from "./range";
import { readHiddenSettings } from "@/lib/applications/hidden";
import { buildInsightsView, type InsightsView } from "./view";

/** The cities with their own row: insights.yaml `cities`, or (empty list) the cities of preferences.yaml `locations`. */
export function insightsCities(configured: readonly string[], locations: () => readonly string[]): string[] {
  if (configured.length > 0) return [...configured];
  const seen = new Set<string>();
  return locations().filter((city) => {
    const key = city.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredLocations(): readonly string[] {
  try {
    return reloadConfig("preferences").locations;
  } catch {
    return [];
  }
}

/** `requestedRange`: the `range` of the URL (days), `at` the instant "today" is taken from (default: the database clock); `locale` names the signal categories. */
export async function loadInsightsView(requestedRange: number | null, at?: Date, locale = "en"): Promise<InsightsView> {
  // the web process has no config watcher and this file is meant to be edited while the page is open
  const config = reloadConfig("insights");
  const timezone = reloadConfig("schedule").timezone;
  const pushLine = reloadConfig("notify").push_min_score;
  const db = getDb();
  // The categories of the signal card and the high-value rule come from interests.yaml
  const interests = reloadConfig("interests");
  const catalog = buildCatalog(interests);
  const listed = toCategoryViews(catalog, locale).filter((category) => category.kind !== "tag");
  const salaryFloorEur = loadSalaryFloor();
  const baseCurrency = loadBaseCurrency();
  const now = at ?? (await getDbNow(db));
  const rangeDays = resolveRangeDays(requestedRange, config.ranges_days, config.default_range_days);
  const window = windowEnding(dayInZone(now, timezone), rangeDays);

  // the same groups as the /jobs city filter, so a figure and the list behind it agree
  const groups = await loadCityGroups(db);
  const cities = insightsCities(config.cities, preferredLocations);
  const data = await getInsightsData(db, {
    window: { ...window, timezone },
    previous: { ...previousWindow(window, rangeDays), timezone },
    cities,
    cityMembers: Object.fromEntries(cities.map((city) => [city, cityMembers(groups, city)])),
    pushMinScore: pushLine,
    topFilterReasons: config.top_filter_reasons,
    scoreBucketWidth: config.score_bucket_width,
    scoreBucketCap: config.score_bucket_cap,
    salaryBucketEur: config.salary_bucket,
    salaryBucketCapEur: config.salary_bucket_cap,
    salaryMinSample: reloadConfig("ui").salary_stats.min_sample,
    highValue: highValuePolicy(interests, salaryFloorEur, baseCurrency),
    signalCategoryIds: listed.map((category) => category.id),
  });
  return buildInsightsView({ data, config, rangeDays, window, pushLine, salaryFloorEur, hiddenStatuses: readHiddenSettings().statuses, currency: baseCurrency ?? "", categories: listed, highValueNames: catalog.highValueIds.map((id) => catalog.labelOf(id, locale)) });
}
