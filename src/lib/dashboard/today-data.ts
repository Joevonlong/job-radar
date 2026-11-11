/** Today selection and tab counts shared by the page and read capabilities, without presentation or URL parsing. */
import { loadConfig } from "@/lib/config";
import { countTodayJobs, countTodayQuickViews, getLatestCycleSummary, hasHighValueCategories, listTodayJobs, type Db, type QuickView } from "@/lib/db";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import { resolveTodayView, TODAY_ALL_VIEW } from "@/lib/interests/view-filters";
import { loadSavedViews } from "@/lib/interests/views";
import { loadCityGroups } from "@/lib/jobs/cities";
import { needsCityGroups, resolveViewCompanyIds, toJobFilters } from "@/lib/jobs/job-filters";
import { loadHighValuePolicy } from "@/lib/signals/floor";
import { visaFilterAvailable } from "@/lib/visa/filter";
import { germanLevelsToHide } from "./german";

export interface TodayParams {
  view?: string | null;
  filtered?: boolean | null;
  hideLang?: boolean | null;
  high?: boolean | null;
  quick?: string | null;
}

export async function loadTodayData(db: Db, params: TodayParams, options: { now: Date; timezone: string; languageEnabled: boolean }) {
  const views = loadSavedViews();
  const { active, filters } = resolveTodayView(views, params.view ?? null, { filtered: params.filtered ?? null, hideLang: params.hideLang ?? null, high: params.high ?? null });
  const filtered = filters.filtered === true;
  const hideLang = options.languageEnabled && filters.hideLang === true;
  const highValue = loadHighValuePolicy();
  const canFilterHigh = hasHighValueCategories(highValue);
  const high = canFilterHigh && filters.high === true;
  const allView = views.some((view) => view.default) ? TODAY_ALL_VIEW : null;
  const viewParam = active ? active.id : allView;
  const quick: Exclude<QuickView, "all"> | null = params.quick === "high" || params.quick === "salary" || params.quick === "following" ? params.quick : null;
  const cityGroups = [filters, ...views.map((view) => view.filters)].some(needsCityGroups) ? await loadCityGroups(db) : null;
  const [shownCompanyIds, ...viewCompanyIds] = await resolveViewCompanyIds(db, [filters, ...views.map((view) => view.filters)]);
  const visa = await visaFilterAvailable(db);
  const ghost = await ghostFilterAvailable(db);
  const notify = loadConfig("notify");
  const qualifiedMinRank = notify.push_min_score;
  const qualifiedMinRankWithSignals = notify.push_min_score_high_value;
  const quickLines = { qualifiedMinRank, qualifiedMinRankWithSignals };
  const summary = await getLatestCycleSummary(db, { ...quickLines, highValue });
  const base = { now: options.now, timezone: options.timezone, cycle: summary, highValue };
  const [cards, quickCounts, viewCounts] = await Promise.all([
    listTodayJobs(db, { ...base, includeFiltered: filtered, quick: active ? null : quick, quickLines, hideGermanLevels: hideLang ? germanLevelsToHide() : [], highValueOnly: high, extra: toJobFilters(filters, { cityGroups, visa, ghost, companyIds: shownCompanyIds }), visa, ghost }),
    countTodayQuickViews(db, { ...base, quickLines }),
    Promise.all(views.map((view, index) => countTodayJobs(db, { ...base, includeFiltered: view.filters.filtered === true, hideGermanLevels: view.filters.hideLang === true ? germanLevelsToHide() : [], highValueOnly: view.filters.high === true, extra: toJobFilters(view.filters, { cityGroups, visa, ghost, companyIds: viewCompanyIds[index] }) }))),
  ]);
  return { views, active, filtered, hideLang, highValue, canFilterHigh, high, allView, viewParam, quick, visa, ghost, qualifiedMinRank, qualifiedMinRankWithSignals, summary, cards, quickCounts, viewCounts };
}
