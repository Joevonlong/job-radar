import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { InsightsPage } from "@/components/insights/insights-view";
import { PageHeader } from "@/components/shell/page-header";
import { reloadConfig } from "@/lib/config";
import { loadInsightsSearchParams } from "@/lib/insights/search-params";
import { loadInsightsView } from "@/lib/insights/load";
import type { InsightsView } from "@/lib/insights/view";

// Reads the database and the config on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.insights");
  return { title: t("title") };
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await loadInsightsSearchParams(searchParams);
  const [t, tInsights] = await Promise.all([getTranslations("pages.insights"), getTranslations("insights")]);
  let view: InsightsView | null = null;
  let defaultRange = 0;
  try {
    defaultRange = reloadConfig("insights").default_range_days;
    view = await loadInsightsView(params.range, undefined, await getLocale());
  } catch {
    view = null;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      {view === null ? (
        <p role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
          {tInsights("unavailable")}
        </p>
      ) : (
        <InsightsPage view={view} defaultRange={defaultRange} />
      )}
    </div>
  );
}
