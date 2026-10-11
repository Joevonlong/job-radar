import { useTranslations } from "next-intl";

import { formatFullTime, formatRelativeTime, toDate } from "@/lib/format/time";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { clamp, cx, pctStyle } from "./util";

/** The bar never gets shorter than this (in %): an old job is a short bar, not an empty one. */
const MIN_BAR_PERCENT = 6;

export interface FreshnessProps {
  /** When the job was first seen. Null: unknown (dashed empty bar). */
  firstSeenAt: Date | string | number | null | undefined;
  /** The clock, passed in so server and browser render the same. */
  now: Date;
  /** Hours until the bar is at its shortest (`ui.yaml: freshness.decay_hours`). */
  decayHours: number;
  /** Hours after which the bar turns yellow with a hatch (`ui.yaml: freshness.warn_hours`). */
  warnHours: number;
  /** Zone the day names ("昨天", dates) are counted in. */
  timeZone?: string;
  className?: string;
}

/** A bar that shrinks as the job ages (72 h by default, yellow after 24 h) and the relative time next to it. */
export function Freshness({ firstSeenAt, now, decayHours, warnHours, timeZone, className }: FreshnessProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const first = toDate(firstSeenAt);
  const options = { locale, ...(timeZone ? { timeZone } : {}) };

  if (first === null) {
    return (
      <span className={cx("jr jr-fresh jr-fresh--unknown", className)} role="img" aria-label={t("fresh.unknown")}>
        <span className="jr-fresh__b" aria-hidden />
        —
      </span>
    );
  }

  const ageHours = Math.max(0, (now.getTime() - first.getTime()) / 3_600_000);
  const percent = clamp(100 - (ageHours / decayHours) * 100, MIN_BAR_PERCENT, 100);
  const stale = ageHours > warnHours;
  const relative = formatRelativeTime(first, now, options);
  const full = formatFullTime(first, options);
  return (
    <PlayOnView
      className={cx("jr-fresh jr-tip", className)}
      data-stale={stale ? "true" : "false"}
      data-tip={t("fresh.tip", { time: full, hours: decayHours })}
      role="meter"
      aria-label={t("fresh.label")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={`${t("fresh.aria", { time: relative })}${stale ? `, ${t("fresh.stale", { hours: warnHours })}` : ""}`}
    >
      <span className="jr-fresh__b" aria-hidden>
        <i className="jr-grow" style={{ width: pctStyle(percent) }} />
      </span>
      {relative}
    </PlayOnView>
  );
}
