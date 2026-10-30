import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActivityList } from "@/components/activity-log/list";
import { PageHeader } from "@/components/shell/page-header";
import { Banner } from "@/components/sources/banner";
import { SourcesSubnav } from "@/components/sources/subnav";
import { loadActivityList } from "@/lib/activity/load";
import { rootIdForCycle } from "@/lib/activity/ids";
import { activitySearchSchema, type ActivitySearchParams } from "@/lib/activity/search";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.logs");
  return { title: t("title") };
}
export default async function Page({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  const params = await searchParams;
  const cycle = activitySearchSchema.parse(params).cycle;
  if (cycle !== undefined) redirect(`/sources/logs/${rootIdForCycle(cycle)}`);
  const [t, log, data] = await Promise.all([getTranslations("pages.logs"), getTranslations("activityLog"), loadActivityList(Promise.resolve(params))]);
  return <div className="flex min-w-0 flex-col gap-sp-4"><PageHeader title={t("title")} description={t("description")} /><SourcesSubnav current="logs" />
    {data.state === "ready" ? <ActivityList data={data} /> : <Banner tone={data.state === "error" ? "bad" : "warn"} testId="activity-log-banner">{log(`banners.${data.state}`)}</Banner>}
  </div>;
}
