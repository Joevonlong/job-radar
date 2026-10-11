import { useTranslations } from "next-intl";

import { PlayOnView } from "@/components/viz";
import { clockBar, type StageClock } from "@/lib/dashboard/board";
import { cn } from "@/lib/utils";

interface OverdueMeterProps {
  clock: StageClock;
  /** From `overdueOf` (strictly longer than the threshold, same rule as the Telegram reminder). */
  overdue: boolean;
  className?: string;
}

/**
 * Days in `interested` / `applied` against the notify.yaml threshold: a bar whose threshold tick sits at two thirds,
 * green up to the tick, red for the part beyond it. The days and the threshold are written above the bar.
 * For assistive tech the meter's scale is the threshold itself: min 0, max = the threshold in days, now = the days capped at the
 * threshold (the tick is the full scale); the overrun is in the value text ("overdue 2 days (limit 7 days)"), not in a made-up max.
 */
export function OverdueMeter({ clock, overdue, className }: OverdueMeterProps) {
  const t = useTranslations("pipeline");
  const { fill, tick } = clockBar(clock);
  const over = clock.days - clock.limitDays;
  const max = clock.limitDays;
  const valueText = overdue ? (over >= 1 ? t("clock.valueOver", { days: over, limit: max }) : t("clock.valueOverNow", { limit: max })) : t(`clock.label.${clock.kind}`, { days: clock.days, limit: max });
  const message = overdue ? t(`overdue.${clock.kind}`, { days: clock.days }) : t(`clock.label.${clock.kind}`, { days: clock.days, limit: clock.limitDays });

  return (
    <PlayOnView as="div" className={cn("flex flex-col gap-0.5", className)} data-slot="overdue-meter" data-testid={overdue ? "card-overdue" : undefined} data-overdue={overdue ? "true" : "false"}>
      <div className="text-data-sm flex justify-between gap-2 font-mono font-bold">
        <span>{t("clock.days", { days: clock.days })}</span>
        <span className={overdue ? "text-bad" : "text-ink-3"}>{overdue ? (over >= 1 ? t("clock.over", { days: over }) : t("clock.overNow")) : t("clock.limit", { limit: clock.limitDays })}</span>
      </div>
      <div
        role="meter"
        aria-label={message}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(clock.days, max)}
        aria-valuetext={valueText}
        className="border-bw border-ink bg-card-bg rounded-cell relative h-2"
      >
        {/* green up to the threshold tick, red for the part beyond it */}
        <i className="jr-grow bg-good absolute inset-y-0 left-0 block" style={{ width: `${Math.min(fill, tick)}%` }} />
        {fill > tick ? <i className="jr-grow bg-bad absolute inset-y-0 block" style={{ left: `${tick}%`, width: `${fill - tick}%` }} /> : null}
        <u aria-hidden className="bg-ink absolute -top-0.5 -bottom-0.5 w-0.5 no-underline" style={{ left: `${tick}%` }} />
      </div>
      {overdue ? (
        <span className="sr-only" aria-hidden>
          {message}
        </span>
      ) : null}
    </PlayOnView>
  );
}
