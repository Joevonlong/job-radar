import type { UiConfig } from "@/lib/config/schemas/ui";

import { known, toPercent } from "./util";

/** Scale of the salary axis, in thousands a year of the market's base currency (`ui.yaml: salary_axis`). */
export interface SalaryAxisScale {
  minK: number;
  maxK: number;
  tickStepK: number;
  /** The base currency the axis, the floor and the median are in ("" = unknown: no currency is written). */
  currency?: string;
}

/** The axis scale of a loaded `ui.yaml`, in the base currency `currency`. */
export function salaryAxisScale(ui: Pick<UiConfig, "salary_axis">, currency = ""): SalaryAxisScale {
  return { minK: ui.salary_axis.min_k, maxK: ui.salary_axis.max_k, tickStepK: ui.salary_axis.tick_step_k, currency };
}

/**
 * The axis that fits the figures actually drawn together (annual amounts in the axis currency; null / NaN are skipped): the
 * smallest to the largest, rounded out to `tickStepK`, one more step on each side, kept inside the configured `axis`. Fewer than
 * two different figures, or a result narrower than two steps, give back `axis` (a lone figure on a tiny axis says nothing).
 */
export function fitSalaryAxis(values: readonly (number | null | undefined)[], axis: SalaryAxisScale): SalaryAxisScale {
  const figures = values.filter(known).map((value) => value / 1000);
  if (new Set(figures).size < 2) return axis;
  const step = axis.tickStepK;
  const minK = Math.max(axis.minK, Math.floor(Math.min(...figures) / step) * step - step);
  const maxK = Math.min(axis.maxK, Math.ceil(Math.max(...figures) / step) * step + step);
  return maxK - minK < 2 * step ? axis : { ...axis, minK, maxK };
}

export type SalaryState = "stated" | "below_floor" | "other_region" | "none";

export interface SalaryStateInput {
  min?: number | null | undefined;
  max?: number | null | undefined;
  floor?: number | null | undefined;
  otherRegion?: boolean | undefined;
}

/**
 * Which of the four looks a salary gets: yellow block (stated), grey block (the stated upper end is below the
 * floor), hatched block (probably another region's pay), dashed frame (not disclosed).
 */
export function salaryState({ min, max, floor, otherRegion }: SalaryStateInput): SalaryState {
  if (!known(min) && !known(max)) return "none";
  if (otherRegion) return "other_region";
  const top = known(max) ? max : null;
  if (top !== null && known(floor) && top < floor) return "below_floor";
  return "stated";
}

/** Position of an amount (EUR a year) on the axis, 0-100 %. Amounts outside the axis sit on its ends. */
export function axisPosition(amount: number, axis: SalaryAxisScale): number {
  return toPercent(amount / 1000, axis.minK, axis.maxK);
}

export interface SalarySpan {
  left: number;
  width: number;
  /** Which end is open (only one bound is stated). */
  open: "start" | "end" | null;
  /** Which end of the stated range lies outside the axis (cut at the axis end): `start` = below the axis minimum, `end` = above its maximum. */
  clip: "start" | "end" | "both" | null;
}

/**
 * Left edge and width (in % of the axis) of a stated range. A bound that is not stated runs to the end of the axis; a bound outside
 * the axis is cut at its end and reported in `clip`, so the block can say it goes on (a 70-250k range on a 40-200k axis must not look like 70-200k).
 */
export function salarySpan(min: number | null | undefined, max: number | null | undefined, axis: SalaryAxisScale): SalarySpan | null {
  if (!known(min) && !known(max)) return null;
  const lo = known(min) ? axisPosition(min, axis) : 0;
  const hi = known(max) ? axisPosition(max, axis) : 100;
  const left = Math.min(lo, hi);
  const right = Math.max(lo, hi);
  const bounds = [known(min) ? min / 1000 : null, known(max) ? max / 1000 : null].filter((value): value is number => value !== null);
  const below = bounds.some((value) => value < axis.minK);
  const above = bounds.some((value) => value > axis.maxK);
  return { left, width: right - left, open: known(min) && known(max) ? null : known(min) ? "end" : "start", clip: below && above ? "both" : below ? "start" : above ? "end" : null };
}

/**
 * Where a text box that must not cover any marker goes on the axis: the middle of the widest gap between the axis ends and the
 * markers (`positions`, % of the axis, null = absent). `width` is the gap's size, the box's widest allowed width. With no marker
 * it is the whole axis, centred. (the "not disclosed" label sat on top of the median line.)
 */
export function freeGap(positions: ReadonlyArray<number | null>): { center: number; width: number } {
  const marks = positions.filter((at): at is number => at !== null).sort((a, b) => a - b);
  const edges = [0, ...marks, 100];
  let best = { center: 50, width: 100 };
  let widest = -1;
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const from = edges[i] as number;
    const to = edges[i + 1] as number;
    if (to - from > widest) {
      widest = to - from;
      best = { center: (from + to) / 2, width: to - from };
    }
  }
  return best;
}

/** Tick values (thousand EUR) from the axis minimum in steps of `tickStepK`. */
export function axisTicks(axis: SalaryAxisScale): number[] {
  const ticks: number[] = [];
  for (let value = axis.minK; value <= axis.maxK + 1e-9; value += axis.tickStepK) ticks.push(Math.round(value * 1000) / 1000);
  return ticks;
}

/**
 * Two marker labels closer than this (in % of the axis) would print over each other: "底线 110k" and "中位 90k" are
 * about 55 px wide, the axis is at least 260 px, so 22 % is the distance at which they just stop touching.
 */
export const LABEL_CLASH_PCT = 22;

/**
 * Label row of each marker so that no two labels on the same row are closer than `clashPct`. `positions` are the
 * markers' places on the axis (0-100 %, null = marker absent), most important first: the first marker keeps row 0,
 * a later one moves up to the next free row. Pure distance maths, no DOM measuring.
 */
export function markerLabelRows(positions: ReadonlyArray<number | null>, clashPct: number = LABEL_CLASH_PCT): number[] {
  const placed: Array<{ at: number; row: number }> = [];
  return positions.map((at) => {
    if (at === null) return 0;
    let row = 0;
    while (placed.some((other) => other.row === row && Math.abs(other.at - at) < clashPct)) row += 1;
    placed.push({ at, row });
    return row;
  });
}

/**
 * Which side of its line a marker's label goes. A label alone sits centred over / right of its line. When another marker's label
 * had to move up a row (`rows`), that marker's taller line runs through the row of this one: the label of a marker in the lower
 * row then stands on the far side of its own line from the other marker (`left` = ends at the line, `right` = starts at it), so no
 * line crosses a label. `null` = no clash, the default placement.
 */
export function markerLabelSides(positions: ReadonlyArray<number | null>, rows: readonly number[]): Array<"left" | "right" | null> {
  const highest = Math.max(0, ...rows);
  return positions.map((at, index) => {
    if (at === null || highest === 0 || (rows[index] ?? 0) === highest) return null;
    // the nearest marker that stands in a higher row
    let nearest: number | null = null;
    positions.forEach((other, j) => {
      if (other === null || j === index || (rows[j] ?? 0) <= (rows[index] ?? 0)) return;
      if (nearest === null || Math.abs(other - at) < Math.abs(nearest - at)) nearest = other;
    });
    if (nearest === null) return null;
    return nearest >= at ? "left" : "right";
  });
}

/** A median label (it runs right of its line) turns left past this share of the axis; a floor label (centred) turns inward this close to an end. */
const MEDIAN_TURN_PERCENT = 55;
const FLOOR_EDGE_PERCENT = 12;

/**
 * Keeps a marker's label inside the axis box: `left` = the label ends at the line, `right` = starts at it, `null` = the default
 * placement fits. Without it a median near the right end ("Median 180.7k") runs past the box and makes a phone page scroll sideways.
 */
export function markerEdgeSide(kind: "floor" | "median", position: number): "left" | "right" | null {
  if (kind === "median") return position > MEDIAN_TURN_PERCENT ? "left" : null;
  if (position > 100 - FLOOR_EDGE_PERCENT) return "left";
  return position < FLOOR_EDGE_PERCENT ? "right" : null;
}

/**
 * A floor label ("Floor 70k", about 60 px) that has to stand left of its line (the median label is on its right) needs this much axis to
 * its left; closer to the start it would run out of the card.
 */
const FLOOR_LEFT_FIT_PERCENT = 26;

export interface MarkerLabelPlan {
  floorRow: number;
  medianRow: number;
  floorSide: "left" | "right" | null;
  medianSide: "left" | "right" | null;
}

/**
 * Where the floor and the median label of one axis stand: row, and side of their line. The floor is the more important marker and keeps
 * row 0; when the two are close and the floor is near the start of the axis, its label would have to turn left and run out of the
 * box, so the median takes row 0 (its label runs right of its line, away from the floor's line) and the floor label goes up a row.
 * Near an end of the axis a label always turns inward (`markerEdgeSide`), which wins over a clash side.
 */
export function markerLabelPlan(floorAt: number | null, medianAt: number | null): MarkerLabelPlan {
  const floorFirst = markerLabelRows([floorAt, medianAt]);
  const nearStart = floorAt !== null && medianAt !== null && medianAt > floorAt && floorAt < FLOOR_LEFT_FIT_PERCENT && Math.max(...floorFirst) > 0;
  const [floorRow = 0, medianRow = 0] = nearStart ? (markerLabelRows([medianAt, floorAt]).reverse() as [number, number]) : floorFirst;
  const [clashFloor = null, clashMedian = null] = markerLabelSides([floorAt, medianAt], [floorRow, medianRow]);
  return {
    floorRow,
    medianRow,
    floorSide: (floorAt === null ? null : markerEdgeSide("floor", floorAt)) ?? clashFloor,
    medianSide: (medianAt === null ? null : markerEdgeSide("median", medianAt)) ?? clashMedian,
  };
}
