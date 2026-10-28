import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Board } from "@/components/pipeline/board";
import { toBoardCards } from "@/components/pipeline/to-board-cards";
import { PageHeader } from "@/components/shell/page-header";
import { HiddenStatusesProvider } from "@/components/applications/visibility-context";
import { readHiddenSettings } from "@/lib/applications/hidden";
import { boardLayout } from "@/lib/applications/visibility";
import { loadConfig } from "@/lib/config";
import { countInPipeline, overdueThresholds } from "@/lib/dashboard/board";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { getDb, listPipelineEntries } from "@/lib/db";
import { visaVisible } from "@/lib/visa/settings";

// The board reads the database and notify.yaml on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.pipeline");
  return { title: t("title") };
}

export default async function PipelinePage() {
  const t = await getTranslations("pages.pipeline");
  const tPipeline = await getTranslations("pipeline");
  const timezone = getDisplayTimeZone();
  const notify = loadConfig("notify");
  const thresholds = overdueThresholds(notify);

  const hidden = readHiddenSettings().statuses;
  const visa = visaVisible();
  const entries = await listPipelineEntries(getDb(), { visa });
  const cards = await toBoardCards(entries, { now: new Date(), timezone, thresholds, visa });
  const counts: Record<string, number> = {};
  for (const card of cards) counts[card.status] = (counts[card.status] ?? 0) + 1;
  const hiddenCards = boardLayout(hidden, counts).hiddenCards;

  return (
    <HiddenStatusesProvider hidden={hidden}>
    <div data-wide className="flex min-w-0 flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")}>
        <p className="text-muted-foreground text-sm" data-testid="pipeline-summary">
          {tPipeline("summary", { count: countInPipeline(cards), interested: thresholds.interestedDays, applied: thresholds.appliedDays })}
        </p>
        {hiddenCards > 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="pipeline-hidden-cards">
            {tPipeline("hiddenCards", { count: hiddenCards })}
          </p>
        ) : null}
      </PageHeader>
      <Board cards={cards} pushLine={notify.push_min_score} thresholds={thresholds} />
    </div>
    </HiddenStatusesProvider>
  );
}
