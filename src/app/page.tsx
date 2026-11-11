import { loadTodayData } from "@/lib/dashboard/today-data";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { createLoader, parseAsBoolean, parseAsString } from "nuqs/server";

import { loadConfig } from "@/lib/config";
import { missingEnvOfEnabled } from "@/lib/sources/required-env";
import { CycleSummaryStrip, TodayCyclesList } from "@/components/jobs/cycle-summary";
import { JobTicker } from "@/components/jobs/job-ticker";
import { KpiStrip } from "@/components/jobs/kpi-strip";
import { QuickFilter } from "@/components/jobs/quick-filter";
import { AutoRefresh } from "@/components/sources/auto-refresh";
import { FilteredToggle } from "@/components/jobs/filtered-toggle";
import { JobList } from "@/components/jobs/job-list";
import { KeyHints } from "@/components/jobs/key-hints";
import { MarkSeenButton } from "@/components/jobs/mark-seen-button";
import { RelistedNote } from "@/components/jobs/relisted-note";
import { NewSinceVisitNote } from "@/components/jobs/new-since-visit-note";
import { ViewTabs, type ViewTab } from "@/components/jobs/view-tabs";
import { VisitTracker } from "@/components/jobs/visit-tracker";
import { toListItems } from "@/components/jobs/to-list-items";
import { ProfileIncompleteBanner } from "@/components/profile/profile-incomplete-banner";
import { PageHeader } from "@/components/shell/page-header";
import { getSchedule } from "@/lib/dashboard/context";
import { buildKpiBlocks } from "@/lib/dashboard/kpi";
import { countTodayScope } from "@/lib/dashboard/today-scope";
import { loadListViz } from "@/lib/dashboard/list-viz";
import { germanLevelsToHide } from "@/lib/dashboard/german";
import { nextScheduledCycle } from "@/lib/dashboard/next-cycle";
import { loadSignalCatalog } from "@/lib/signals/floor";
import { withLegacyKeys } from "@/lib/jobs/search-params";
import { countTodayRelisted, countUnscoredJobs, getDb, getDbNow, getFilterFloors, getOpenAiRun, getVisitState, listCycleNewJobs, listMonthSalaryFigures, listRecentCycleKpis, listTodayCycleSummaries, type QuickView } from "@/lib/db";
import { processingFailed } from "@/lib/cycle/step-health";
import { todayHref } from "@/lib/interests/view-filters";
import { salaryFilteredIds } from "@/lib/jobs/filter-floors";
import { effectiveSeenUpTo } from "@/lib/jobs/visit";
import { readProfileReadiness } from "@/lib/scoring/profile";
import { VisibilityScope } from "@/components/applications/visibility-scope";
import { localLanguageName } from "@/lib/market/view";

// `null` = not in the URL: an explicit value (also `false`) wins over the active saved view.
const loadTodayParams = createLoader({
  view: parseAsString,
  filtered: parseAsBoolean,
  hideLang: parseAsBoolean,
  // the old name of `hideLang`: still read, never written
  hideGerman: parseAsBoolean,
  high: parseAsBoolean,
  // the old name of `high`: still read, never written
  t12: parseAsBoolean,
  quick: parseAsString,
});

export async function generateMetadata(): Promise<Metadata> {
  const [t, tApp] = await Promise.all([getTranslations("pages.today"), getTranslations("app")]);
  // the root layout's title template does not apply to the page of the same segment: spell the suffix out
  return { title: { absolute: `${t("title")} · ${tApp("name")}` } };
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = withLegacyKeys(await loadTodayParams(searchParams));
  const [t, tToday, tSignals, tViews, tCycle, format, locale] = await Promise.all([
    getTranslations("pages.today"),
    getTranslations("dashboard.today"),
    getTranslations("signals.filter"),
    getTranslations("interests.today"),
    getTranslations("dashboard.cycle"),
    getFormatter(),
    getLocale(),
  ]);

  const schedule = getSchedule();
  const now = new Date();
  const db = getDb();
  const languageName = localLanguageName(locale);
  const { views, active, filtered, hideLang, highValue, canFilterHigh, high, allView, viewParam, quick, visa, ghost, qualifiedMinRank, qualifiedMinRankWithSignals, summary, cards, quickCounts, viewCounts } = await loadTodayData(db, params, { now, timezone: schedule.timezone, languageEnabled: languageName !== null });
  const catalog = loadSignalCatalog();
  const highValueNames = catalog ? catalog.highValueIds.map((id) => catalog.labelOf(id, locale)) : [];
  const hrefWith = (toggles: { filtered: boolean; hideLang: boolean; high: boolean }) => todayHref({ view: viewParam, toggles, ...(active ? { viewFilters: active.filters } : {}) });
  const ui = loadConfig("ui");
  const relistBadgeDays = loadConfig("jobArchive").relist.badge_days;
  const [aiRun, dbNow, todayCycles, cycleKpis, salaryFigures, visit, relistedCount] = await Promise.all([
    getOpenAiRun(db),
    getDbNow(db),
    listTodayCycleSummaries(db, { now, timezone: schedule.timezone, qualifiedMinRank, qualifiedMinRankWithSignals, highValue }),
    listRecentCycleKpis(db, { limit: ui.trend_cycles, qualifiedMinRank, qualifiedMinRankWithSignals, highValue }),
    listMonthSalaryFigures(db, { now, timeZone: schedule.timezone, currency: highValue.baseCurrency ?? "" }),
    getVisitState(db),
    countTodayRelisted(db, {
      now,
      timezone: schedule.timezone,
      cycle: summary,
      badgeSince: new Date(now.getTime() - relistBadgeDays * 86_400_000),
      includeFiltered: filtered,
      hideGermanLevels: hideLang ? germanLevelsToHide() : [],
      highValueOnly: high,
      highValue,
    }),
  ]);
  // Scoring is paused while me.yaml has neither a summary nor skills; say so above everything else.
  const profile = readProfileReadiness();
  const profileMissing = profile?.missing ?? [];
  const waitingForScore = profileMissing.length > 0 ? await countUnscoredJobs(db).catch(() => null) : null;
  const missingEnv = missingEnvOfEnabled(loadConfig("channels"), process.env, summary?.channels.map((c) => c.channelId) ?? []);
  const seenUpTo = effectiveSeenUpTo(visit, now);
  const filterFloors = await getFilterFloors(db, salaryFilteredIds(cards));
  const items = await toListItems(cards, { now, timezone: schedule.timezone, filterFloors, seenUpTo, relistBadgeDays, visa, ghost, monthSalaries: { figures: salaryFigures, minSample: ui.salary_stats.min_sample } });
  const kpiBlocks = buildKpiBlocks(cycleKpis, ui.trend_cycles);
  const cycleNewJobs = summary ? await listCycleNewJobs(db, summary, ui.ticker_max_items) : [];
  const cycleTime = summary ? format.dateTime(summary.startedAt, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: schedule.timezone }) : "";
  const cycleLabel = summary ? tCycle("run", { kind: tCycle(`kind.${summary.kind}`), time: cycleTime }) : "";
  const scope = countTodayScope(cards, { now, timezone: schedule.timezone, cycle: summary });
  // "mark all seen" here covers the jobs of the view on screen; the visit marker only says how many are new since then
  const unseenIds = items.filter((item) => item.seen === false).map((item) => item.id);
  const newCount = items.filter((item) => item.isNew).length;
  const next = nextScheduledCycle(schedule, now);
  const processingBroken = summary !== null && processingFailed(summary.steps) && summary.unprocessed > 0;

  const noToggles = { filtered: false, hideLang: false, high: false };
  const quickTab = (key: QuickView): ViewTab => ({
    key: key === "all" ? "all" : `quick-${key}`,
    label: tViews(`quick.${key}`),
    href: todayHref({ view: allView, toggles: noToggles, quick: key === "all" ? null : key }),
    active: active === null && (key === "all" ? quick === null : quick === key),
    isDefault: false,
    count: quickCounts[key],
  });
  const tabs: ViewTab[] = [
    quickTab("all"),
    quickTab("high"),
    quickTab("salary"),
    quickTab("following"),
    ...views.map((view, index) => ({ key: view.id, label: view.name, href: todayHref({ view: view.id, toggles: noToggles }), active: active?.id === view.id, isDefault: view.default, count: viewCounts[index] ?? 0 })),
  ];

  return (
    <VisibilityScope>
    <div data-wide className="flex min-w-0 flex-col gap-sp-4">
      <PageHeader title={t("title")} description={tToday("subtitle", { date: format.dateTime(now, { dateStyle: "full", timeZone: schedule.timezone }) })} />
      <ProfileIncompleteBanner missing={profileMissing} waiting={waitingForScore} />
      <VisitTracker />
      <AutoRefresh active={aiRun !== null || summary?.status === "running"} />
      <JobTicker summary={summary} newJobs={cycleNewJobs} timezone={schedule.timezone} maxItems={ui.ticker_max_items} />
      <KpiStrip blocks={kpiBlocks} cycleLabel={cycleLabel} cycleTime={cycleTime} sourceCount={summary?.channels.length ?? 0} pushLine={qualifiedMinRank} />
      <CycleSummaryStrip summary={summary} next={next} timezone={schedule.timezone} now={now} aiRun={aiRun} dbNow={dbNow} missingEnv={missingEnv} />
      <TodayCyclesList cycles={todayCycles} timezone={schedule.timezone} />
      <ViewTabs tabs={tabs} />
      <div className="flex flex-wrap items-center gap-x-sp-3 gap-y-sp-2">
        <FilteredToggle active={filtered} href={hrefWith({ filtered: !filtered, hideLang, high })} />
        {/* Only while the market has a local-language step */}
        {languageName !== null ? (
          <QuickFilter
            active={hideLang}
            href={hrefWith({ filtered, hideLang: !hideLang, high })}
            offLabel={tToday("hideGerman", { language: languageName })}
            onLabel={tToday("hideGermanOn", { language: languageName })}
            removeLabel={tToday("showGerman", { language: languageName })}
            testId="toggle-hide-german"
          />
        ) : null}
        {canFilterHigh ? (
          <QuickFilter
            active={high}
            href={hrefWith({ filtered, hideLang, high: !high })}
            offLabel={tSignals("high")}
            onLabel={tSignals("high")}
            removeLabel={tToday("highRemove")}
            testId="toggle-high"
            title={tSignals("highTitle", { names: highValueNames.join(" / ") })}
          />
        ) : null}
        <span className="inline-flex flex-wrap items-center gap-x-sp-3 gap-y-sp-2 md:ml-auto">
          {newCount > 0 ? <NewSinceVisitNote count={newCount} /> : null}
          {relistedCount > 0 ? <RelistedNote count={relistedCount} filtered={filtered} hideLang={hideLang} high={high} /> : null}
          <MarkSeenButton count={unseenIds.length} target={{ scope: "list", jobIds: unseenIds }} />
        </span>
        <span className="font-mono text-data text-ink-2" role="status">
          <span data-testid="result-count">{tToday("count", { count: items.length })}</span>
          {scope.cycle === null ? null : <span data-testid="result-scope">{tToday("scope", { cycle: scope.cycle, today: scope.today })}</span>}
        </span>
      </div>
      <JobList jobs={items} label={tToday("listLabel")} empty={active ? tViews("empty") : processingBroken ? (
          <>
            <span data-testid="empty-unprocessed">{tToday("emptyUnprocessed", { fetched: summary.fetched, count: summary.unprocessed })}</span>{" "}
            <Link href="/jobs" className="text-foreground font-medium underline underline-offset-2" data-testid="empty-unprocessed-link">
              {tToday("emptyUnprocessedLink")} →
            </Link>
          </>
        ) : quick ? tViews("emptyQuick") : tToday("empty")} viz={loadListViz(now, schedule.timezone)} />
      <KeyHints />
    </div>
    </VisibilityScope>
  );
}
