"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import "@/components/viz/viz.css";
import { cx } from "@/components/viz/util";
import { clockText, dayPercent, minutesNow, quietSegments, timelineRuns, type CycleInput, type QuietInput, type RunKind, type TimelineRun } from "@/lib/settings/timeline";

/** The "now" line is redrawn this often; a minute-level clock needs nothing finer. */
const NOW_REFRESH_MS = 30_000;
/** More slots than this on the day are drawn as thin ticks without a label (a cron like `*\/5 * * * *`). */
const LABELLED_RUNS_MAX = 8;
const HOUR_MARKS = [0, 6, 12, 18, 24] as const;

interface ScheduleTimelineProps {
  cycles: readonly CycleInput[];
  /** Time zone being edited / saved (`schedule.yaml: timezone`); an invalid one falls back to `fallbackTimeZone`. */
  timeZone: string;
  fallbackTimeZone: string;
  /** notify.yaml quiet hours as saved; null when notify.yaml cannot be read or has none. */
  quiet: QuietInput | null;
  /** Server time at render, so the first paint matches the server (the client then keeps it current). */
  initialNow: string;
}

function useNow(initial: string): Date {
  const [now, setNow] = useState(() => new Date(initial));
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const kindColour: Record<RunKind, string> = {
  weekday: "bg-hi text-hi-ink",
  weekend: "bg-signal-t2 text-on-signal",
  daily: "bg-hi text-hi-ink",
};

/** A switched-off cycle keeps its slot on the day, dimmed: dashed box, no shadow, grey struck-through time (a hatched tick when there are too many slots to label). */
const OFF_CHIP = "border-dashed bg-card text-ink-3 line-through opacity-70";
const OFF_TICK = "jr-hatch border-dashed text-ink-3 opacity-70";

/**
 * The 24 h strip of the schedule tab (design system `s-settings`): when the cycles run on weekdays (yellow, above
 * the bar) and at the weekend (teal, below), the hatched quiet hours of notify.yaml, and a red line for now in the
 * schedule's time zone. It follows the cron fields as they are being edited, so a change is visible before saving.
 */
export function ScheduleTimeline({ cycles, timeZone, fallbackTimeZone, quiet, initialNow }: ScheduleTimelineProps) {
  const t = useTranslations("settings.timeline");
  const now = useNow(initialNow);

  const zone = minutesNow(now, timeZone) !== null ? timeZone : fallbackTimeZone;
  const nowMinutes = minutesNow(now, zone);
  const runs = timelineRuns(cycles);
  const segments = quietSegments(quiet);
  const labelled = runs.length <= LABELLED_RUNS_MAX;

  const runName = (run: TimelineRun): string => t(`kind.${run.kind}`);
  const runTip = (run: TimelineRun): string => `${runName(run)} ${clockText(run.minutes)} · ${t(`cycle.${run.id as "weekday_morning" | "weekday_evening" | "weekend"}`)}${run.enabled ? "" : ` · ${t("off")}`}`;
  const quietText = segments.length === 0 || quiet === null ? t("quietNone") : t("quiet", { start: quiet.start, end: quiet.end });

  const times = (kind: RunKind): string => {
    const list = runs.filter((run) => run.kind === kind).map((run) => `${clockText(run.minutes)}${run.enabled ? "" : ` (${t("off")})`}`);
    return list.length > 0 ? list.join(" · ") : "—";
  };
  const summary = [`${t("kind.weekday")} ${times("weekday")}`, `${t("kind.weekend")} ${times("weekend")}`, ...(runs.some((run) => run.kind === "daily") ? [`${t("kind.daily")} ${times("daily")}`] : []), quietText, nowMinutes === null ? "" : t("now", { time: clockText(nowMinutes) })]
    .filter((part) => part !== "")
    .join("；");

  const lane = (run: TimelineRun): "top" | "bottom" => (run.kind === "weekend" ? "bottom" : "top");

  return (
    <div className="flex flex-col gap-3" data-testid="schedule-timeline">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-cap-style text-ink-3">{t("title")}</span>
        <span className="text-data text-ink-3 font-mono" data-testid="timeline-zone">
          {zone}
        </span>
      </div>
      <div className="px-7 pt-5" role="img" aria-label={summary}>
        <div className="relative h-[5.75rem]">
          {/* the day bar: hatched where notifications are quiet */}
          <div className="border-border bg-card-bg rounded-tag border-bw absolute inset-x-0 top-9 h-4 overflow-hidden">
            {segments.map((segment) => (
              <span
                key={`${segment.from}-${segment.to}`}
                className="jr-hatch text-grid absolute inset-y-0"
                data-testid="timeline-quiet"
                data-from={segment.from}
                data-to={segment.to}
                style={{ left: `${dayPercent(segment.from)}%`, width: `${dayPercent(segment.to) - dayPercent(segment.from)}%` }}
              />
            ))}
          </div>
          {runs.map((run) => (
            // the positioned wrapper is separate from the tooltip element: `.jr-tip` sets position: relative
            <span
              key={`${run.id}-${run.minutes}`}
              data-testid="timeline-run"
              data-kind={run.kind}
              data-enabled={run.enabled ? "true" : "false"}
              data-minutes={run.minutes}
              className={cx("absolute z-10 -translate-x-1/2", labelled ? (lane(run) === "top" ? "top-2.5" : "top-[3.25rem]") : "top-9")}
              style={{ left: `${dayPercent(run.minutes)}%` }}
            >
              {labelled ? (
                <span className={cx("jr-tip border-border rounded-tag border-bw grid h-6 w-14 place-items-center font-mono text-data-sm font-bold", run.enabled ? `shadow-e1 ${kindColour[run.kind]}` : OFF_CHIP)} data-tip={runTip(run)}>
                  {clockText(run.minutes)}
                </span>
              ) : (
                <span className={cx("jr-tip border-border block h-4 w-[0.1875rem] border-x-[1.5px]", run.enabled ? kindColour[run.kind] : OFF_TICK)} data-tip={runTip(run)} />
              )}
            </span>
          ))}
          {nowMinutes !== null ? (
            <span data-testid="timeline-now" data-minutes={nowMinutes} className="bg-bad absolute top-0 bottom-4 z-0 w-0.5" style={{ left: `${dayPercent(nowMinutes)}%` }}>
              <span className="text-bad absolute -top-4 left-1 font-mono text-data-sm font-bold whitespace-nowrap">{t("now", { time: clockText(nowMinutes) })}</span>
            </span>
          ) : null}
          {HOUR_MARKS.map((hour) => (
            <span key={hour} aria-hidden className="text-ink-3 absolute bottom-0 -translate-x-1/2 font-mono text-data-sm" style={{ left: `${dayPercent(hour * 60)}%` }}>
              {String(hour).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>
      <ul className="text-ink-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-data">
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="bg-hi border-border size-3 rounded-cell border-[1.5px]" />
          {t("kind.weekday")}
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="bg-signal-t2 border-border size-3 rounded-cell border-[1.5px]" />
          {t("kind.weekend")}
        </li>
        {runs.some((run) => !run.enabled) ? (
          <li className="flex items-center gap-1.5" data-testid="timeline-off-legend">
            <i aria-hidden className="jr-hatch text-ink-3 border-border size-3 rounded-cell border-[1.5px] border-dashed opacity-70" />
            {t("offLegend")}
          </li>
        ) : null}
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="jr-hatch text-ink-3 border-border size-3 rounded-cell border-[1.5px]" />
          {quietText}
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="bg-bad border-border size-3 rounded-cell border-[1.5px]" />
          {t("nowLegend")}
        </li>
      </ul>
    </div>
  );
}
