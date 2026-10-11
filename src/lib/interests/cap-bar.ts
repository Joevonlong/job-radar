/**
 * Geometry of the bonus-cap bar on /interests: the categories' points stacked on one scale, the cap as a
 * red line, and whatever sticks out past the cap hatched (it does not count towards the rank value). Pure, so the
 * bar can follow the weight fields as they are typed and the numbers can be tested.
 */

/** One category's weight as typed. */
export interface WeightEntry {
  id: string;
  weight: string;
}

/** Cells in one weight bar. */
export const WEIGHT_CELLS = 10;
/** The weight bars cover at least this many points (the default weights are 10 at most): one cell = one point. */
export const WEIGHT_SCALE_BASE = 10;

export interface WeightScale {
  /** Points the full bar stands for (a multiple of `WEIGHT_SCALE_BASE`, at least the largest weight): 10, 20, 30 ... */
  max: number;
  /** Points one cell stands for: 1 on the base scale, 2 at 20 ... The number and the cells always agree. */
  perCell: number;
}

/**
 * One scale for all rows, so a weight above 10 is not drawn like 10: the bar grows in steps of 10 points
 * (10 -> 20 -> 30) and every cell stands for `max / 10` points. Weights are free numbers (the schema only says >= 0).
 */
export function weightScale(weights: readonly WeightEntry[]): WeightScale {
  const largest = Math.max(0, ...weights.map((entry) => parseWeight(entry.weight) ?? 0));
  const max = Math.max(WEIGHT_SCALE_BASE, Math.ceil(largest / WEIGHT_SCALE_BASE) * WEIGHT_SCALE_BASE);
  return { max, perCell: max / WEIGHT_CELLS };
}

/** A typed weight as a number; anything that is not a plain non-negative decimal is null (the field reports it). */
export function parseWeight(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export interface CapSegment {
  /** Category id. */
  id: string;
  value: number;
  /** Width in % of the bar. */
  width: number;
}

export interface CapBar {
  /** Every category hit: the most one job can collect before the cap. */
  sum: number;
  cap: number | null;
  /** Points the whole track stands for: the larger of the sum and the cap, so the bar is full (no empty rest) and the cap line is on the track. */
  scale: number;
  /** What counts: `min(sum, cap)`; the whole sum while the cap is not a number. */
  counted: number;
  /** The part of the sum past the cap (0 when none). */
  over: number;
  segments: CapSegment[];
  /** Position of the cap line in % of the bar; null without a cap. */
  capAt: number | null;
  /** The hatched stretch past the cap, in % of the bar; null when the sum stays under the cap. */
  overflow: { left: number; width: number } | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function capBar(weights: readonly WeightEntry[], capText: string): CapBar {
  const values = weights.map((entry) => ({ id: entry.id, value: parseWeight(entry.weight) ?? 0 }));
  const sum = round2(values.reduce((total, entry) => total + entry.value, 0));
  const cap = parseWeight(capText);
  const scale = Math.max(sum, cap ?? 0, 1);
  const over = cap !== null && sum > cap ? round2(sum - cap) : 0;
  return {
    sum,
    cap,
    scale,
    counted: cap === null ? sum : Math.min(sum, cap),
    over,
    segments: values.map(({ id, value }) => ({ id, value, width: round2((value / scale) * 100) })),
    capAt: cap === null ? null : round2((cap / scale) * 100),
    overflow: cap !== null && over > 0 ? { left: round2((cap / scale) * 100), width: round2((over / scale) * 100) } : null,
  };
}
