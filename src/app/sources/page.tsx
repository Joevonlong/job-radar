import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AiHealthCard } from "@/components/sources/ai-health-card";
import { AiUsageCard } from "@/components/sources/ai-usage-card";
import { AiWorkerCard } from "@/components/sources/ai-worker-card";
import { HeartbeatBanner } from "@/components/sources/heartbeat-banner";
import { Banner } from "@/components/sources/banner";
import { AutoRefresh } from "@/components/sources/auto-refresh";
import { CandidatesNotice } from "@/components/sources/candidates-notice";
import { SourcesSubnav } from "@/components/sources/subnav";
import { CascadeCard } from "@/components/sources/cascade-card";
import { ChannelCard } from "@/components/sources/channel-card";
import { OtherMarketChannels } from "@/components/sources/other-market-channels";
import { PendingChannels } from "@/components/sources/pending-channels";
import { DiskNotice } from "@/components/sources/disk-notice";
import { SummaryStrip } from "@/components/sources/summary-strip";
import { PageHeader } from "@/components/shell/page-header";
import { getDb } from "@/lib/db";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { loadDiskStatus } from "@/lib/ops/disk";
import { loadBoardCandidates } from "@/lib/sources/candidates";
import { loadSourcesView } from "@/lib/sources/load";
import type { SourcesView } from "@/lib/sources/view";

// Reads the database and the config on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.sources");
  return { title: t("title") };
}

export default async function Page() {
  const [t, tSources] = await Promise.all([getTranslations("pages.sources"), getTranslations("sources")]);
  let view: SourcesView | null = null;
  try {
    view = await loadSourcesView();
  } catch {
    view = null;
  }
  const candidates = view === null ? null : await loadBoardCandidates();
  const timeZone = getDisplayTimeZone();
  const disk = view === null ? null : await loadDiskStatus(getDb());

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <SourcesSubnav current="overview" />
      {view === null ? (
        <Banner tone="bad">{tSources("page.unavailable")}</Banner>
      ) : (
        <>
          <AutoRefresh active={view.latestCycle?.status === "running"} />
          <DiskNotice disk={disk} />
          <HeartbeatBanner runner={view.runner} aiWorker={view.aiWorker} />
          <SummaryStrip view={view} disk={disk} timeZone={timeZone} aiWorker={<AiWorkerCard worker={view.aiWorker} timeZone={timeZone} />} />
          <CascadeCard cascade={view.cascade} hasCycle={view.latestCycle !== null} alertPercent={view.budgetAlertPercent} />
          <section aria-label={tSources("page.channels")} className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {view.cards
              .filter((card) => card.registered && !card.otherMarket)
              .map((card) => (
                <ChannelCard key={card.id} card={card} timeZone={timeZone} healthCycles={view.healthCycles} alertPercent={view.budgetAlertPercent} />
              ))}
          </section>
          <PendingChannels cards={view.cards.filter((card) => !card.registered && !card.otherMarket)} />
          <OtherMarketChannels cards={view.cards.filter((card) => card.otherMarket)} />
          <CandidatesNotice count={candidates?.length ?? 0} />
          <AiHealthCard providers={view.ai.providers} timeZone={timeZone} alertPercent={view.budgetAlertPercent} />
          <AiUsageCard ai={view.ai} month={view.month} />
        </>
      )}
    </div>
  );
}
