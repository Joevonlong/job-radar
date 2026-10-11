import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AiUsagePage } from "@/components/ai-usage/ai-usage-page";
import { PageHeader } from "@/components/shell/page-header";
import { Banner } from "@/components/sources/banner";
import { SourcesSubnav } from "@/components/sources/subnav";
import { loadAiUsagePage, type AiUsagePageData } from "@/lib/ai-usage/load";

// Reads the database and the config on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.aiUsage");
  return { title: t("title") };
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, tUsage] = await Promise.all([getTranslations("pages.aiUsage"), getTranslations("aiUsage")]);
  let data: AiUsagePageData | null = null;
  try {
    data = await loadAiUsagePage(searchParams);
  } catch {
    data = null;
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <SourcesSubnav current="aiUsage" />
      {data === null ? <Banner tone="bad">{tUsage("unavailable")}</Banner> : <AiUsagePage data={data} />}
    </div>
  );
}
