/** The quantiles kept per benchmark group: p10, p20, ..., p90. */
export const QUANTILE_POINTS = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;

/** Linear-interpolated quantile `q` (0..1) of sorted values (the "type 7" definition: position (n - 1) * q). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("quantile of an empty list");
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower] as number;
  const b = sorted[upper] as number;
  return a + (b - a) * (position - lower);
}

/** The nine quantiles p10..p90 of `values` (any order). */
export function quantilesOf(values: readonly number[]): number[] {
  const sorted = [...values].sort((x, y) => x - y);
  return QUANTILE_POINTS.map((point) => quantile(sorted, point / 100));
}

export interface PercentilePosition {
  /** 10..90, interpolated between the stored quantiles. */
  value: number;
  /** Below p10 / above p90: shown as "<10" / ">90". */
  clamp: "below" | "above" | null;
}

/**
 * Where `figure` stands within a group, from its nine quantiles: interpolated between neighbouring quantiles; below p10
 * or above p90 it is clamped. Equal quantiles (many equal salaries) give the middle of their span.
 */
export function percentileIn(quantiles: readonly number[], figure: number): PercentilePosition | null {
  if (quantiles.length !== QUANTILE_POINTS.length || !Number.isFinite(figure)) return null;
  const first = quantiles[0] as number;
  const last = quantiles[quantiles.length - 1] as number;
  if (figure < first) return { value: 10, clamp: "below" };
  if (figure > last) return { value: 90, clamp: "above" };
  // the span of points whose quantile equals the figure (or the neighbours it lies between)
  let low = -1;
  let high = -1;
  for (let i = 0; i < quantiles.length; i += 1) {
    if ((quantiles[i] as number) === figure) {
      if (low === -1) low = i;
      high = i;
    }
  }
  if (low !== -1) return { value: ((QUANTILE_POINTS[low] as number) + (QUANTILE_POINTS[high] as number)) / 2, clamp: null };
  for (let i = 0; i < quantiles.length - 1; i += 1) {
    const a = quantiles[i] as number;
    const b = quantiles[i + 1] as number;
    if (figure > a && figure < b) {
      const share = (figure - a) / (b - a);
      return { value: (QUANTILE_POINTS[i] as number) + share * 10, clamp: null };
    }
  }
  return null;
}
