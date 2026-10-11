import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { FavoritesSort } from "@/components/favorites/favorites-sort";
import { JobList } from "@/components/jobs/job-list";
import { KeyHints } from "@/components/jobs/key-hints";
import { toListItems } from "@/components/jobs/to-list-items";
import { PageHeader } from "@/components/shell/page-header";
import { loadConfig } from "@/lib/config";
import { getSchedule } from "@/lib/dashboard/context";
import { loadListViz } from "@/lib/dashboard/list-viz";
import { getDb, getFilterFloors, listFavoriteJobs, listMonthSalaryFigures } from "@/lib/db";
import { salaryFilteredIds } from "@/lib/jobs/filter-floors";
import { loadFavoritesSearchParams } from "@/lib/jobs/search-params";
import { VisibilityScope } from "@/components/applications/visibility-scope";
import { loadBaseCurrency } from "@/lib/signals/floor";
import { ghostEnabled } from "@/lib/ghost/settings";
import { visaVisible } from "@/lib/visa/settings";

/** Every starred job, unfiltered: closed, filtered-out and ignored jobs stay here, marked on their rows. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.favorites");
  return { title: t("title") };
}

export default async function FavoritesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await loadFavoritesSearchParams(searchParams);
  const [t, tf] = await Promise.all([getTranslations("pages.favorites"), getTranslations("favorites.page")]);
  const { timezone } = getSchedule();
  const now = new Date();
  const db = getDb();
  const visa = visaVisible();
  const ghost = ghostEnabled();
  const [cards, salaryFigures] = await Promise.all([listFavoriteJobs(db, { sort: params.sort, visa, ghost }), listMonthSalaryFigures(db, { now, timeZone: timezone, currency: loadBaseCurrency() ?? "" })]);
  const filterFloors = await getFilterFloors(db, salaryFilteredIds(cards));
  const items = await toListItems(cards, { now, timezone, filterFloors, visa, ghost, monthSalaries: { figures: salaryFigures, minSample: loadConfig("ui").salary_stats.min_sample } });
  const closed = cards.filter((card) => card.status !== "active").length;

  return (
    <VisibilityScope>
    <div data-wide className="flex min-w-0 flex-col gap-sp-4">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-wrap items-center gap-x-sp-3 gap-y-sp-2">
        <FavoritesSort active={params.sort} />
        <span className="font-mono text-data text-ink-2" role="status" data-testid="favorites-count">
          {tf("count", { count: items.length })}
          {closed > 0 ? tf("closed", { closed, count: items.length }) : ""}
        </span>
      </div>
      <JobList
        mode="favorites"
        jobs={items}
        label={tf("listLabel")}
        empty={
          <span data-testid="favorites-empty">
            {tf("empty")}{" "}
            <Link href="/jobs" className="text-foreground font-medium underline underline-offset-2">
              {tf("emptyLink")} →
            </Link>
          </span>
        }
        viz={loadListViz(now, timezone)}
      />
      <p className="text-sm">
        <Link href="/jobs?fav=true" className="text-foreground inline-flex min-h-sp-6 items-center font-medium underline underline-offset-2" data-testid="favorites-filter-link">
          {tf("filterLink")} →
        </Link>
      </p>
      <KeyHints />
    </div>
    </VisibilityScope>
  );
}
