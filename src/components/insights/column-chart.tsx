import Link from "next/link";

import { PlayOnView } from "@/components/viz";
import { toneVar, type VizTone } from "@/components/viz/util";
import { cn } from "@/lib/utils";

import "./insights.css";

export interface ChartSegment {
  value: number;
  tone: VizTone;
  /** Hatched (the "filtered out / not counted" look) instead of a solid block. */
  hatch?: boolean;
  href?: string | undefined;
  /** Accessible name of the segment (what a link to it opens). */
  name?: string | undefined;
}

export interface ChartColumn {
  key: string;
  /** Tooltip and accessible text of the whole column. */
  text: string;
  /** Segments, bottom first. */
  segments: ChartSegment[];
  /** Axis label under the column; null = none. */
  tick?: string | null;
  /** Show the tick on a phone too (the others only from the `sm` breakpoint). */
  tickOnPhone?: boolean;
}

export interface ChartMarker {
  key: string;
  kind: "floor" | "median";
  /** Position across the plot, 0 to 100. */
  position: number;
  label: string;
  tone: VizTone;
  /** 0, 1, ...: which line of labels (so two labels do not overlap). */
  row?: number;
}

interface ColumnChartProps {
  columns: readonly ChartColumn[];
  /** The value of a full-height column. */
  max: number;
  /** Accessible name of the whole chart. */
  label: string;
  testId: string;
  /** Number shown at the top of the axis (formatted by the caller). */
  maxLabel: string;
  /** Number shown at the middle gridline. */
  midLabel?: string;
  /** Height of the plot area (a CSS length from the spacing scale). */
  plotHeight?: string;
  markers?: readonly ChartMarker[];
}

/**
 * Which columns get an axis label: every one while there are at most `limit`, else every `ceil(n / limit)`-th.
 * Callers fill `tick` with this so a 90-day chart keeps five labels on a phone.
 */
export function tickIndexes(count: number, limit: number): Set<number> {
  const step = Math.max(1, Math.ceil(count / limit));
  const out = new Set<number>();
  for (let i = 0; i < count; i += step) out.add(i);
  return out;
}

/**
 * Axis labels for a phone and for a desktop. The desktop set is a superset of the phone set (its step divides the
 * phone step), so the two never put labels next to each other.
 */
export function tickSets(count: number, phoneLimit: number, desktopLimit: number): { phone: Set<number>; desktop: Set<number> } {
  const phoneStep = Math.max(1, Math.ceil(count / phoneLimit));
  let step = phoneStep;
  for (let candidate = 1; candidate <= phoneStep; candidate += 1) {
    if (phoneStep % candidate === 0 && Math.ceil(count / candidate) <= desktopLimit) {
      step = candidate;
      break;
    }
  }
  const phone = new Set<number>();
  const desktop = new Set<number>();
  for (let i = 0; i < count; i += step) desktop.add(i);
  for (let i = 0; i < count; i += phoneStep) phone.add(i);
  return { phone, desktop };
}

/**
 * Stacked columns in plain HTML: the data is a few dozen numbers and every column must be a link, a tooltip and
 * screen-reader text. A column is a stack of segments (bottom first), each optionally a link. The columns grow in
 * steps when the chart scrolls into view (and again when its `key` changes: a new time range replays it).
 */
export function ColumnChart({ columns, max, label, testId, maxLabel, midLabel, plotHeight = "var(--space-10)", markers = [] }: ColumnChartProps) {
  const dense = columns.length > 45;
  // the marker labels sit in a band above the plot; the chart reserves that band so the card header never cuts them off
  const markRows = markers.length === 0 ? 0 : Math.max(...markers.map((marker) => marker.row ?? 0)) + 1;
  return (
    <PlayOnView as="div" className="ins-chart" data-testid={testId} style={{ "--plot-h": `calc(${plotHeight} * 4)`, "--col-pad": dense ? "1px" : "2px", "--mark-rows": markRows } as React.CSSProperties}>
      <div className="ins-chart__y" aria-hidden>
        <span style={{ top: 0 }}>{maxLabel}</span>
        {midLabel ? <span style={{ top: "50%" }}>{midLabel}</span> : null}
        <span style={{ top: "100%" }}>0</span>
      </div>
      <div className="ins-plot">
        <span className="ins-plot__grid" style={{ top: 0 }} aria-hidden />
        <span className="ins-plot__grid" style={{ top: "50%" }} aria-hidden />
        <span className="ins-plot__grid" style={{ top: "100%", borderTopColor: "var(--ink)" }} aria-hidden />
        <ol aria-label={label} className="ins-cols">
          {columns.map((column, index) => {
            const total = column.segments.reduce((sum, s) => sum + s.value, 0);
            const hasLink = column.segments.some((segment) => segment.href && segment.value > 0);
            return (
              <li key={column.key} className="ins-col jr-tip" data-tip={column.text} data-total={total}>
                {hasLink ? null : <span className="sr-only">{column.text}</span>}
                {total > 0 ? (
                  <div className="ins-stack" style={{ height: `${Math.min(100, (total / (max > 0 ? max : 1)) * 100)}%` }}>
                    {column.segments
                      .filter((segment) => segment.value > 0)
                      .map((segment, i) => {
                        const className = cn("ins-seg jr-growy", segment.hatch && "ins-hatch");
                        const style = { flexGrow: segment.value, flexBasis: 0, "--c": toneVar(segment.tone), "--n": index } as React.CSSProperties;
                        return segment.href ? (
                          <Link key={i} href={segment.href} className={className} style={style} aria-label={segment.name ?? column.text} />
                        ) : (
                          <span key={i} className={className} style={style} />
                        );
                      })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {markers.map((marker) => (
          <span key={marker.key} className="ins-mark" data-kind={marker.kind} data-flip={marker.position > 60 ? "true" : "false"} style={{ left: `${marker.position}%`, "--c": toneVar(marker.tone), "--row": marker.row ?? 0 } as React.CSSProperties}>
            <span className="ins-mark__l">{marker.label}</span>
          </span>
        ))}
      </div>
      <div className="ins-chart__x" aria-hidden>
        {columns.map((column) => (
          <span key={column.key}>{column.tick ? <span data-phone={column.tickOnPhone ? "true" : "false"}>{column.tick}</span> : null}</span>
        ))}
      </div>
    </PlayOnView>
  );
}
