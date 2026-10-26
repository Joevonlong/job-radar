/** Tolerance for floating point USD comparisons (the budget tracker uses the same precision). */
const EPSILON = 1e-9;

/** Items affordable after a run's flat fee; zero means even one item is unaffordable. */
export function affordableItems(usdLeft: number, perItemUsd: number, startUsd: number): number {
  if (usdLeft + EPSILON < startUsd + perItemUsd) return 0;
  if (perItemUsd <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((usdLeft - startUsd + EPSILON) / perItemUsd);
}
