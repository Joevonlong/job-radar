import { useTranslations } from "next-intl";
import { useId } from "react";

import { formatInteger, formatPercent, UNKNOWN } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { cx, known } from "./util";

export interface SparklineProps {
  /** One value per round, oldest first. A null is a gap in the line (unknown, not zero). */
  values: ReadonlyArray<number | null | undefined>;
  width?: number;
  height?: number;
  /** How the numbers in the tooltip are written. */
  format?: "integer" | "percent";
  /**
   * What a null does to the line. Default (`false`): a gap, the line breaks there. `true`: the line bridges it, one continuous step line
   * through the known values at their own days (for a metric that does not exist on every day, e.g. the pass rate of a day with no jobs,
   * where broken pieces and lonely dots would look like noise). The tooltip still says "—" for the day without a value.
   */
  bridgeGaps?: boolean;
  className?: string;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Step line with a hatched area under it and a yellow dot on the newest round. Hover shows the value of every
 * round. The newest value belongs next to it in the page (summary block), this is the shape.
 */
export function Sparkline({ values, width = 120, height = 34, format = "integer", bridgeGaps = false, className }: SparklineProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const patternId = `jr-hatch-${useId().replace(/\W/g, "")}`;
  const known_ = values.filter(known);

  const text = (value: number | null | undefined): string => {
    if (!known(value)) return UNKNOWN;
    if (format === "percent") return formatPercent(value);
    return Number.isInteger(value) ? formatInteger(value, locale) : String(Math.round(value * 10) / 10);
  };

  if (known_.length === 0) {
    return (
      <span className={cx("jr jr-spark jr-spark--empty", className)} style={{ width, height }} role="img" aria-label={t("spark.empty")}>
        {UNKNOWN}
      </span>
    );
  }

  // one round with data is no trend: a lonely dot floating in empty space says nothing, so say it in words (the value is next to it in the page)
  if (known_.length === 1) {
    return (
      <span className={cx("jr jr-spark jr-spark--single", className)} style={{ width }} role="img" aria-label={t("spark.aria", { count: values.length, first: text(known_[0]), last: text(known_[0]) })} data-testid="spark-single">
        {t("spark.single", { count: 1 })}
      </span>
    );
  }

  const min = Math.min(...known_);
  const max = Math.max(...known_);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (value: number): number => (max === min ? height / 2 : height - 3 - ((value - min) / (max - min)) * (height - 8));

  // One sub-path per run of known values; the area under each run closes down to the baseline.
  const runs: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (known(value)) {
      current.push({ x: values.length > 1 ? index * step : width / 2, y: y(value) });
    } else if (current.length > 0 && !bridgeGaps) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) runs.push(current);

  // A run of fewer than two known values has no line to draw (a step needs two points); it keeps only its dot, so a
  // series that is mostly gaps never turns into a sliver. The x-range always covers the whole width, gaps included.
  const drawn = runs.filter((run) => run.length >= 2);
  const pathOf = (run: Point[]): string => run.map((point, i) => (i === 0 ? `M${point.x.toFixed(1)} ${point.y.toFixed(1)}` : `H${point.x.toFixed(1)} V${point.y.toFixed(1)}`)).join(" ");
  const line = drawn.map(pathOf).join(" ");
  const area = drawn.map((run) => `${pathOf(run)} V${height} H${(run[0] as Point).x.toFixed(1)} Z`).join(" ");
  const lastRun = runs[runs.length - 1] as Point[];
  const end = lastRun[lastRun.length - 1] as Point;
  const lonely = runs.filter((run) => run.length === 1 && run !== lastRun);

  const firstKnown = known_[0];
  const lastKnown = known_[known_.length - 1];
  const aria = t("spark.aria", { count: values.length, first: text(firstKnown), last: text(lastKnown) });

  return (
    <PlayOnView className={cx("jr-spark", className)} style={{ width, height }} role="img" aria-label={aria}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
        <defs>
          <pattern id={patternId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="1.6" height="5" style={{ fill: "var(--ink)" }} opacity="0.28" />
          </pattern>
        </defs>
        {drawn.length > 0 ? (
          <>
            <path d={area} fill={`url(#${patternId})`} stroke="none" />
            <path className="jr-spark__ln" pathLength={100} d={line} />
          </>
        ) : null}
        {lonely.map((run, i) => (
          <circle key={i} className="jr-spark__pt" cx={(run[0] as Point).x.toFixed(1)} cy={(run[0] as Point).y.toFixed(1)} r="2" />
        ))}
        <circle className="jr-spark__dot" cx={end.x.toFixed(1)} cy={end.y.toFixed(1)} r="4" />
      </svg>
      {values.map((value, index) => {
        // the hit areas stay inside the sparkline: with only a few rounds the half-step overhang at the ends would widen the page
        const from = values.length > 1 ? Math.max(0, index * step - step / 2) : 0;
        const to = values.length > 1 ? Math.min(width, index * step + step / 2) : width;
        const left = from;
        const hitWidth = to - from;
        return <span key={index} className="jr-spark__hit jr-tip" style={{ left, width: hitWidth }} data-tip={t("spark.point", { i: index + 1, value: text(value) })} />;
      })}
    </PlayOnView>
  );
}
