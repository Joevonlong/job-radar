import { getFormatter, getTranslations } from "next-intl/server";

import { Battery, Led, type LedTone } from "@/components/viz";
import { formatPercent } from "@/lib/format/numbers";
import type { DiskStatus } from "@/lib/ops/disk";
import { ageParts } from "@/lib/settings/age";
import type { SourcesView } from "@/lib/sources/view";

import { cycleFace, STATE_TONE, stateWords } from "@/components/jobs/cycle-state";
import { cn } from "@/lib/utils";

import { Block, BlockNote, BlockState } from "./block";
import { CycleStepIssues } from "./cycle-steps";
import { formatUsd, formatWhen } from "./format";
import { UsageBar } from "./usage-bar";

/**
 * The disk battery counts what is used (a battery is a use-up quota): used share of the volume, and the red line at
 * the share that is left when the free space falls to `warnGb` (schedule.yaml `doctor.warn_free_disk_gb`).
 */
export function diskBattery(disk: Pick<DiskStatus, "freeGb" | "totalGb" | "warnGb">): { used: number; threshold: number } | null {
  if (!(disk.totalGb > 0)) return null;
  const used = (1 - disk.freeGb / disk.totalGb) * 100;
  const threshold = (1 - disk.warnGb / disk.totalGb) * 100;
  return { used: Math.min(100, Math.max(0, used)), threshold: Math.min(100, Math.max(0, threshold)) };
}

/** The top rows of /sources: runner, AI worker (its own card), the global paid cap and the disk; then the latest cycle and the AI API budget. */
export async function SummaryStrip({ view, disk, timeZone, aiWorker }: { view: SourcesView; disk: DiskStatus | null; timeZone: string; aiWorker: React.ReactNode }) {
  const [t, tCycle, tAge, format] = await Promise.all([
    getTranslations("sources"),
    getTranslations("dashboard.cycle"),
    getTranslations("settings.control.age"),
    getFormatter(),
  ]);
  const { runner, latestCycle } = view;
  const age = runner.ageSeconds === null ? null : (() => {
    const parts = ageParts(runner.ageSeconds);
    return tAge(parts.unit, { count: parts.count });
  })();
  const runnerTone: LedTone = runner.ageSeconds === null ? "idle" : runner.online ? "good" : "bad";
  const diskGauge = disk === null ? null : diskBattery(disk);
  // the cycle's state in words: a cycle whose steps failed never reads "finished"
  const face = latestCycle ? cycleFace({ status: latestCycle.status, steps: latestCycle.steps ?? [], failedChannels: latestCycle.channels.filter((channel) => channel.failed > 0).length, finishedAt: null }) : null;
  const cycleTone = face?.tone ?? "ok";
  const cycleState = face ? stateWords(tCycle, face, () => "", { finishedAt: null }) : "";

  return (
    <div className="flex flex-col gap-4" data-testid="sources-summary">
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Block
          label={<Led tone={runnerTone} live={runner.online} label={t("runner.title")} />}
          data-testid="runner-card"
          data-state={runner.ageSeconds === null ? "never" : runner.online ? "online" : "stale"}
        >
          <BlockState>{runner.ageSeconds === null ? t("runner.never") : runner.online ? t("runner.online") : t("runner.stale")}</BlockState>
          {age ? (
            <BlockNote>
              {t("runner.heartbeat", { age })} · {t("runner.interval", { seconds: runner.intervalSeconds })}
            </BlockNote>
          ) : null}
        </Block>

        {aiWorker}

        <Block label={t("budget.title")} data-testid="paid-card">
          <UsageBar
            value={view.paid.usedUsd}
            max={view.paid.capUsd}
            label={t("budget.global")}
            valueText={t("budget.usd", { used: formatUsd(format, view.paid.usedUsd), limit: formatUsd(format, view.paid.capUsd) })}
            threshold={view.budgetAlertPercent}
            testId="global-bar"
          />
        </Block>

        <Block label={t("disk.title")} data-testid="disk-card" data-level={disk?.level ?? "unknown"}>
          {disk !== null && diskGauge !== null ? (
            <>
              <Battery value={diskGauge.used} threshold={diskGauge.threshold} ariaLabel={t("disk.title")} />
              <BlockNote>{t("disk.usage", { used: formatPercent(diskGauge.used), free: format.number(disk.freeGb, { maximumFractionDigits: 0 }) })}</BlockNote>
            </>
          ) : (
            <>
              <Battery value={null} threshold={0} ariaLabel={t("disk.title")} />
              <BlockNote>{t("disk.unknown")}</BlockNote>
            </>
          )}
        </Block>
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Block label={t("cycle.title")} data-testid="latest-cycle-card" data-cycle-id={latestCycle?.id ?? ""} data-status={latestCycle?.status ?? "none"}>
          {latestCycle ? (
            <>
              <BlockNote className={cn("text-body-sm font-sans font-semibold", cycleTone === "ok" ? "text-ink" : STATE_TONE[cycleTone])} data-testid="latest-cycle-line" data-tone={cycleTone}>
                {t("cycle.line", {
                  id: latestCycle.id,
                  kind: tCycle(`kind.${latestCycle.kind}`),
                  state: cycleState,
                  time: formatWhen(format, latestCycle.startedAt, timeZone),
                })}
              </BlockNote>
              <CycleStepIssues steps={latestCycle.steps ?? []} unprocessed={latestCycle.unprocessed ?? 0} fetched={latestCycle.channels.reduce((sum, channel) => sum + channel.fetched, 0)} />
            </>
          ) : (
            <BlockNote>{t("cycle.none")}</BlockNote>
          )}
        </Block>

        <Block label={t("ai.apiBudget")} data-testid="ai-budget-card">
          <UsageBar
            value={view.ai.apiSpendUsd}
            max={view.ai.budgetUsd}
            label={t("ai.title")}
            valueText={t("budget.usd", { used: formatUsd(format, view.ai.apiSpendUsd), limit: formatUsd(format, view.ai.budgetUsd) })}
            threshold={view.budgetAlertPercent}
            testId="ai-bar"
          />
        </Block>
      </div>
    </div>
  );
}
