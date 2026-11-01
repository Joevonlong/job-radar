import type { CSSProperties, ReactNode } from "react";

import { axisPosition, axisTicks, salarySpan, type SalaryAxisScale } from "@/components/viz/salary-shared";
import { cn } from "@/lib/utils";

/** How a block on the ruler looks: the stated range (yellow), below the floor (grey), the peer spread, AI estimates (hatched, or dotted for total pay). */
export type SpanTone = "jd" | "jd-muted" | "group" | "ai" | "ai-total";

export type LaneMark =
  | { type: "span"; min: number | null; max: number | null; tone: SpanTone; testId?: string }
  | { type: "median"; value: number }
  | { type: "points"; points: ReadonlyArray<{ value: number; count: number }> };

export interface RulerLane {
  kind: "jd" | "group" | "company" | "ai";
  /** `data-state` of the row. */
  state: string;
  label: string;
  /** Where the figures come from and how far they can be trusted, written under the label. */
  source: string;
  /** The row's figures as text: the row's text is the complete information, the drawing is a picture of it. */
  values: string | null;
  /** Why nothing is drawn: written where the track would be. */
  reason: string | null;
  reasonTestId?: string;
  marks: LaneMark[];
  /** Extra `data-*` attributes of the row. */
  data?: Record<string, string>;
}

const HATCH = "repeating-linear-gradient(135deg, var(--ink-3) 0 1.5px, transparent 1.5px 5px)";
const DOTS = "radial-gradient(circle at 3px 3px, var(--ink-3) 1.1px, transparent 1.4px)";

const SPAN_CLASS: Record<SpanTone, string> = {
  jd: "bg-hi border-border border-bw rounded-tag shadow-e1",
  "jd-muted": "bg-soft border-border border-bw rounded-tag text-ink-3",
  group: "bg-ink-3/45 border-ink-3 rounded-tag border",
  ai: "bg-card-bg border-ink-2 rounded-tag border-[1.5px] border-dashed",
  "ai-total": "bg-card-bg border-ink-2 rounded-tag border-[1.5px] border-dashed",
};

const spanStyle = (tone: SpanTone): CSSProperties =>
  tone === "ai" ? { backgroundImage: HATCH } : tone === "ai-total" ? { backgroundImage: DOTS, backgroundSize: "6px 6px" } : {};

/** Share of the track the figure sits at (cut at both ends). */
const at = (value: number, axis: SalaryAxisScale): number => Math.round(axisPosition(value, axis) * 100) / 100;

function Clip({ side }: { side: "start" | "end" }) {
  return (
    <span aria-hidden className={cn("text-data-sm text-ink absolute top-1/2 -translate-y-1/2 font-mono leading-none font-bold", side === "start" ? "left-0.5" : "right-0.5")}>
      {side === "start" ? "«" : "»"}
    </span>
  );
}

function Mark({ mark, axis }: { mark: LaneMark; axis: SalaryAxisScale }) {
  if (mark.type === "span") {
    const span = salarySpan(mark.min, mark.max, axis);
    if (!span) return null;
    return (
      <div
        className={cn("absolute top-1/2 h-5 min-w-1.5 -translate-y-1/2", SPAN_CLASS[mark.tone], span.open === "end" && "border-r-dashed", span.open === "start" && "border-l-dashed")}
        style={{ left: `${span.left}%`, width: `${span.width}%`, ...spanStyle(mark.tone) }}
        data-testid={mark.testId}
        data-tone={mark.tone}
        data-clip={span.clip ?? undefined}
      >
        {span.clip === "start" || span.clip === "both" ? <Clip side="start" /> : null}
        {span.clip === "end" || span.clip === "both" ? <Clip side="end" /> : null}
      </div>
    );
  }
  if (mark.type === "median") {
    return <div className="border-ink absolute inset-y-0 w-0 -translate-x-px border-l-2 border-dashed" style={{ left: `${at(mark.value, axis)}%` }} data-mark="median" />;
  }
  return (
    <>
      {mark.points.map((point) => {
        const outside = point.value / 1000 < axis.minK ? "start" : point.value / 1000 > axis.maxK ? "end" : null;
        return (
          <span key={point.value} className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5" style={{ left: `${at(point.value, axis)}%` }} data-mark="point" data-count={point.count}>
            {outside === "start" ? <span className="text-data-sm font-mono font-bold">«</span> : null}
            <span className="bg-ink border-card-bg size-3 shrink-0 rounded-full border-2" />
            {point.count > 1 ? <span className="text-data-sm text-ink font-mono">×{point.count}</span> : null}
            {outside === "end" ? <span className="text-data-sm font-mono font-bold">»</span> : null}
          </span>
        );
      })}
    </>
  );
}

/** The grid of the lane rows: label and source beside the track from `sm` up, above it on a phone. */
const ROW_GRID = "grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)]";

export interface SalaryRulerProps {
  lanes: RulerLane[];
  /** The scale every row shares. */
  axis: SalaryAxisScale;
  /** The user's floor and its visible text; null = no floor (no line is drawn). */
  floor: { amount: number; text: string } | null;
  /** `aria-label` of the list. */
  label: string;
  children?: ReactNode;
}

/**
 * One scale for every source of the salary: a list of rows (the posting, similar postings, the company's other postings, the
 * AI estimate), each with its label, where its figures come from and how far they can be trusted, the drawing and the figures
 * as text. The drawing (track, blocks, points, ticks, the floor line) is hidden from assistive technology; the row's text says all of it.
 */
export function SalaryRuler({ lanes, axis, floor, label, children }: SalaryRulerProps) {
  const ticks = axisTicks(axis);
  const every = Math.max(1, Math.ceil(ticks.length / 8));
  const segments = Math.max(1, Math.round((axis.maxK - axis.minK) / axis.tickStepK));
  const gridlines: CSSProperties = { backgroundImage: `repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px calc(100% / ${segments}))` };
  const floorAt = floor ? at(floor.amount, axis) : null;

  return (
    <div className="flex flex-col gap-2" data-testid="salary-ruler-wrap">
      <div className={ROW_GRID} aria-hidden>
        <span className="hidden sm:block" />
        <div className="text-ink-3 text-data-sm relative h-4 font-mono" data-testid="salary-ruler-ticks">
          {ticks.map((tick, index) =>
            index % every === 0 ? (
              // the ends of the scale keep their numbers inside the box (a centred last label would run past the panel on a phone)
              <span key={tick} className={cn("absolute", index === 0 ? "" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${at(tick * 1000, axis)}%` }}>
                {tick}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <ul className="flex flex-col gap-3" aria-label={label} data-testid="salary-ruler">
        {lanes.map((lane) => (
          <li key={lane.kind} className={ROW_GRID} data-testid={`salary-lane-${lane.kind}`} data-state={lane.state} {...Object.fromEntries(Object.entries(lane.data ?? {}).map(([key, value]) => [`data-${key}`, value]))}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-body-sm font-semibold [overflow-wrap:anywhere]">{lane.label}</p>
              {lane.source !== "" ? (
                <p className="text-ink-3 text-data font-mono [overflow-wrap:anywhere]" data-testid={`salary-lane-${lane.kind}-source`}>
                  {lane.source}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              {lane.reason !== null ? (
                <p className="border-border text-muted-foreground rounded-tag text-body-sm border-[1.5px] border-dashed px-2.5 py-1.5 [overflow-wrap:anywhere]" data-testid={lane.reasonTestId}>
                  {lane.reason}
                </p>
              ) : (
                <div className="relative h-7" style={gridlines} aria-hidden data-testid={`salary-track-${lane.kind}`}>
                  {lane.marks.map((mark, index) => (
                    <Mark key={index} mark={mark} axis={axis} />
                  ))}
                  {floorAt !== null ? <div className="bg-bad absolute inset-y-0 w-0.5 -translate-x-px" style={{ left: `${floorAt}%` }} data-mark="floor" /> : null}
                </div>
              )}
              {lane.values !== null ? <p className="text-body-sm font-mono [overflow-wrap:anywhere]">{lane.values}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {floor ? (
        <p className="text-ink-2 text-body-sm flex items-center gap-2" data-testid="salary-ruler-floor">
          <span className="bg-bad h-3.5 w-0.5 shrink-0" aria-hidden />
          {floor.text}
        </p>
      ) : null}
      {children}
    </div>
  );
}
