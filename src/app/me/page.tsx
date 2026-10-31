import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { ProfileEditor } from "@/components/profile/profile-editor";
import { ProfileIncompleteBanner } from "@/components/profile/profile-incomplete-banner";
import { PageHeader } from "@/components/shell/page-header";
import { salaryAxisScale, type SalaryAxisScale } from "@/components/viz";
import { reloadConfig } from "@/lib/config";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { userGermanLabelOrNull } from "@/lib/dashboard/german";
import { countUnscoredJobs, getDb, listMonthSalaryFigures, listMonthStatedSalaries } from "@/lib/db";
import { summarizeMonthSalaries } from "@/lib/domain/salary";
import { isTranslatedRegion, loadMarketView } from "@/lib/market/view";
import type { SalaryMedian } from "@/lib/profile/floor-preview";
import { loadProfilePage } from "@/lib/profile/view";
import { readProfileReadiness } from "@/lib/scoring/profile";

/** The shipped config/ui.yaml scale, used only while ui.yaml cannot be read. */
const FALLBACK_AXIS: SalaryAxisScale = { minK: 40, maxK: 200, tickStepK: 20 };
const FALLBACK_MIN_SAMPLE = 5;

// Reads the profile files and the database on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.me");
  return { title: t("title") };
}

export default async function Page() {
  const t = await getTranslations("pages.me");
  const data = await loadProfilePage();
  // Scoring waits for a summary or skills; the banner goes away with the save that adds one.
  const profileMissing = readProfileReadiness()?.missing ?? [];
  const waiting = profileMissing.length > 0 ? await countUnscoredJobs(getDb()).catch(() => null) : null;
  // The floor preview counts this month's stated salaries; without the database it simply has none.
  const timezone = getDisplayTimeZone();
  const tMarket = await getTranslations("market.regions");
  const market = loadMarketView(await getLocale(), (id) => (isTranslatedRegion(id) ? tMarket(id) : null));
  const salaries = data.dbAvailable ? await listMonthStatedSalaries(getDb(), { timezone, currency: market.currency }).catch(() => []) : [];
  // ui.yaml is read on every request (no hot reload); when it is broken the settings tab says so and the axis uses the shipped scale
  let axis: SalaryAxisScale = { ...FALLBACK_AXIS, currency: market.currency };
  let minSample = FALLBACK_MIN_SAMPLE;
  try {
    const ui = reloadConfig("ui");
    axis = salaryAxisScale(ui, market.currency);
    minSample = ui.salary_stats.min_sample;
  } catch {
    // keep the fallback
  }
  // the median of the preview is the detail page's, by the same function (one definition of "median" in the app)
  const figures = data.dbAvailable ? await listMonthSalaryFigures(getDb(), { now: new Date(), timeZone: timezone, currency: market.currency }).catch(() => []) : [];
  const summary = summarizeMonthSalaries(figures, { jobId: 0, figure: null, minSample });
  const salaryMedian: SalaryMedian = { value: summary.median, count: summary.count, minSample };
  // search.yaml cities: shown next to the places of "What I want", which they do not follow by themselves
  let searchLocations: string[] = [];
  try {
    searchLocations = [...reloadConfig("search").locations];
  } catch {
    // an unreadable search.yaml is reported by its settings tab
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <ProfileIncompleteBanner missing={profileMissing} waiting={waiting} showLink={false} />
      <ProfileEditor me={data.me} preferences={data.preferences} stories={data.stories} storyLimits={data.storyLimits} staleScores={data.staleScores} dbAvailable={data.dbAvailable} salaries={salaries} axis={axis} salaryMedian={salaryMedian} market={market} searchLocations={searchLocations} userLanguageLevel={userGermanLabelOrNull()} />
    </div>
  );
}
