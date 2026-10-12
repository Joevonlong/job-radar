import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { Ticker, type TickerItem } from "@/components/viz";
import { processingFailed } from "@/lib/cycle/step-health";
import { annualSalaryLabel } from "@/lib/dashboard/salary";
import type { CycleNewJob, CycleSummary } from "@/lib/db/queries/today";
import { formatScoreValue, UNKNOWN } from "@/lib/format/numbers";

import { cycleFace, stateWords } from "./cycle-state";

export interface JobTickerProps {
  /** The latest cycle; null before the first one (the ticker then says nothing is new). */
  summary: CycleSummary | null;
  /** The cycle's new jobs, best first (`listCycleNewJobs`). */
  newJobs: readonly CycleNewJob[];
  timezone: string;
  /** `ui.yaml: ticker_max_items`. */
  maxItems: number;
}

/** The strip under the page header: the cycle itself, sources that failed in it, then its new jobs (title · company · salary · score). Pauses on hover. */
export async function JobTicker({ summary, newJobs, timezone, maxItems }: JobTickerProps) {
  const [t, tc, format, locale] = await Promise.all([getTranslations("dashboard.ticker"), getTranslations("dashboard.cycle"), getFormatter(), getLocale()]);
  const items: TickerItem[] = [];

  if (summary) {
    const time = format.dateTime(summary.startedAt, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
    // a cycle whose processing failed has no "new jobs" yet: say what waits instead of 0
    const waiting = processingFailed(summary.steps) && summary.unprocessed > 0;
    items.push({
      key: `run-${summary.id}`,
      tag: "RUN",
      text: tc("run", { kind: tc(`kind.${summary.kind}`), time }),
      accent: waiting ? t("runCountsWaiting", { fetched: summary.fetched, waiting: summary.unprocessed }) : t("runCounts", { fetched: summary.fetched, fresh: summary.newCount }),
    });
    // the same words and the same step list as the cycle card under it: failed steps first, then the partly done ones
    const face = cycleFace(summary);
    if (face.steps.length > 0) {
      items.push({ key: `steps-${summary.id}`, tag: "ERR", text: stateWords(tc, face, () => "", summary) });
    }
    for (const channel of summary.channels) {
      if (channel.outcome !== "failed" && channel.outcome !== "interrupted" && channel.outcome !== "circuit_open") continue;
      const word = channel.outcome === "circuit_open" ? tc("circuitOpen") : channel.outcome === "interrupted" ? tc("outcome.interrupted") : tc("outcome.failed");
      items.push({ key: `src-${channel.channelId}`, tag: "SRC", text: `${channel.channelId} ${word}` });
    }
  }
  for (const job of newJobs) {
    const salary = annualSalaryLabel(job.salary, locale) ?? t("noSalary");
    const score = job.rankValue === null ? UNKNOWN : formatScoreValue(job.rankValue);
    items.push({ key: `job-${job.id}`, tag: "NEW", text: `${job.title} · ${job.companyName}`, accent: `${salary} · ${score}` });
  }
  return <Ticker items={items} maxItems={maxItems} className="w-full" />;
}
