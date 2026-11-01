import { useLocale, useTranslations } from "next-intl";

import { resolveLocale } from "@/i18n/locale";
import { formatPostedAgo, formatPostedDate, formatPostedFull, formatSeenAt } from "@/lib/format/posted-date";
import { formatFullTime } from "@/lib/format/time";
import type { PostedView } from "@/lib/jobs/posted-view";
import { cn } from "@/lib/utils";

interface DateStripProps {
  view: PostedView;
  firstSeenAt: Date;
  now: Date;
  /** The display zone (`schedule.yaml: timezone`). */
  timezone: string;
  /** The families the job was found in (LinkedIn, Greenhouse...), shown after the first-seen time. */
  sourceNames: readonly string[];
  /** `channel id -> name` for the sentence about channels that state the date themselves. */
  channelNames: Readonly<Record<string, string>>;
  /** The "seen again" text of a job that came back after an absence; null = none. Kept as it was before the strip. */
  relistedText: string | null;
}

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-tag border-bw border-border px-2 py-0.5 text-body-sm font-bold whitespace-normal";

/**
 * The dates under the status chips of the detail page, the concrete day first and the relative time in brackets: the posted date
 * (always `jobs.posted_at`), a chip for a relisting under a new link (the day *we* first saw the new link, never called "posted"),
 * and when we first found the job. Each chip carries its explanation twice: as a tooltip, and as screen-reader text inside the chip.
 */
export function DateStrip({ view, firstSeenAt, now, timezone, sourceNames, channelNames, relistedText }: DateStripProps) {
  const t = useTranslations("dashboard.detail.dateStrip");
  const options = { locale: resolveLocale(useLocale()), timeZone: timezone };
  const { postedAt, repost } = view;

  const trustTip = view.trust.kind === "trusted" ? t("tip.trusted", { channels: view.trust.channelIds.map((id) => channelNames[id] ?? id).join(", ") }) : view.trust.kind === "aggregator" ? t("tip.aggregator") : null;
  let postedLabel: string;
  const postedTips: string[] = [];
  if (postedAt) {
    postedLabel = t("posted", { date: formatPostedDate(postedAt, now, options, { weekday: true }), ago: formatPostedAgo(postedAt, now, options) });
    const full = formatPostedFull(postedAt, options);
    postedTips.push(full.zone === null ? t("tip.dateOnly", { date: full.text }) : t("tip.full", { time: full.text, zone: full.zone }));
    if (trustTip) postedTips.push(trustTip);
  } else {
    postedLabel = t("postedUnknown");
    postedTips.push(t("tip.unknown"));
  }
  const postedTip = postedTips.join("; ");

  let repostLabel: string | null = null;
  let repostTip = "";
  if (repost?.kind === "events") {
    const date = formatPostedDate(repost.newSeen, now, options);
    const oldest = formatPostedDate(repost.oldestSeen, now, options);
    repostLabel = t("repost", { date, ago: formatPostedAgo(repost.newSeen, now, options) });
    const tips = [repost.count === 1 ? t("tip.repost", { date, oldest, gap: repost.gapDays }) : t(repost.capped ? "tip.repostManyCapped" : "tip.repostMany", { date, oldest, count: repost.count })];
    if (repost.label) tips.push(t("tip.repostLabel", { label: repost.label }));
    repostTip = tips.join("; ");
  } else if (repost?.kind === "label") {
    repostLabel = t("repostNoDate");
    repostTip = t("tip.repostLabelOnly", { label: repost.label });
  }

  const firstSeenFull = formatFullTime(firstSeenAt, options);
  return (
    <div className="text-ink-2 text-data flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono" role="group" aria-label={t("label")} data-testid="date-strip">
      <span className={cn(CHIP, postedAt ? "bg-hi text-hi-ink" : "bg-soft text-ink font-semibold")} title={postedTip} data-testid="posted-date" data-known={postedAt ? "true" : "false"}>
        {postedAt ? <time dateTime={postedAt.toISOString()}>{postedLabel}</time> : postedLabel}
        <span className="sr-only">{`. ${postedTip}`}</span>
      </span>
      {repostLabel ? (
        <span className={cn(CHIP, "bg-soft text-ink")} title={repostTip} data-testid="repost-date" data-kind={repost?.kind}>
          <span aria-hidden>↻</span>
          {repostLabel}
          <span className="sr-only">{`. ${repostTip}`}</span>
        </span>
      ) : null}
      <span data-testid="first-seen" title={t("tip.full", { time: firstSeenFull, zone: timezone })}>
        {t("firstSeen", { time: formatSeenAt(firstSeenAt, now, options) })}
        {sourceNames.length > 0 ? ` · ${sourceNames.join(" · ")}` : ""}
        {relistedText ? <span data-testid="relisted-detail">{` · ${relistedText}`}</span> : null}
      </span>
    </div>
  );
}
