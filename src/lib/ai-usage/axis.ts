/** Axis maximum of the daily chart: a round number whose half is round too, so the tick labels are never `7172.5`. */

const SMALL_COUNT_STEPS = [2, 4, 6, 8, 10] as const;
/** Mantissas x10 for counts of 11 and more: every one is even, so half of it is a whole number. */
const COUNT_STEPS = [10, 12, 14, 16, 18, 20, 24, 30, 40, 50, 60, 70, 80, 100] as const;
const MONEY_STEPS = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

const clean = (value: number): number => Math.round(value * 1e9) / 1e9;

/**
 * Smallest round number >= `max`. A count (calls, tokens: `integer`) gets an even number so that half of it is whole;
 * money keeps its decimals. 0 stays 0.
 */
export function niceAxisMax(max: number, integer: boolean): number {
  if (!(max > 0)) return 0;
  if (integer && max <= 10) return SMALL_COUNT_STEPS.find((step) => step >= max) ?? 10;
  const exponent = Math.floor(Math.log10(max));
  if (integer) {
    const scale = 10 ** (exponent - 1);
    return clean((COUNT_STEPS.find((step) => step * scale >= max - 1e-9) ?? 100) * scale);
  }
  const scale = 10 ** exponent;
  return clean((MONEY_STEPS.find((step) => step * scale >= max - 1e-9) ?? 10) * scale);
}
