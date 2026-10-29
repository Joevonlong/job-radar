import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ActivityDetail } from "@/components/activity-log/detail";
import { PageHeader } from "@/components/shell/page-header";
import { SourcesSubnav } from "@/components/sources/subnav";
import { Banner } from "@/components/sources/banner";
import { loadActivityDetail } from "@/lib/activity/load";
import type { ActivitySearchParams } from "@/lib/activity/search";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.logs");
  return { title: t("detailTitle") };
}
export default async function Page({ params, searchParams }: { params: Promise<{ rootId: string }>; searchParams: Promise<ActivitySearchParams> }) {
  const { rootId } = await params;
  const [t, log, data] = await Promise.all([getTranslations("pages.logs"), getTranslations("activityLog"), loadActivityDetail(rootId, searchParams)]);
  return <div className="flex min-w-0 flex-col gap-sp-4">{data.state === "ready" ? <ActivityDetail data={data} /> : <><PageHeader title={t("detailTitle")} description={t("description")} /><SourcesSubnav current="logs" />{data.state === "not_found" ? <p data-testid="activity-log-not-found">{log("notFound")}</p> : <Banner tone={data.state === "error" ? "bad" : "warn"}>{log(`banners.${data.state}`)}</Banner>}<Link href="/sources/logs" className="underline">{log("back")}</Link></>}</div>;
}
