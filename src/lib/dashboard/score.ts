import { SCORE_BANDS } from "./constants";

export type ScoreTone = "top" | "good" | "mid" | "low";

/** Colour band of a rank value (docs/design/tokens.md: <50, 50-69, 70-84, >=85). */
export function scoreTone(value: number): ScoreTone {
  if (value >= SCORE_BANDS.top) return "top";
  if (value >= SCORE_BANDS.good) return "good";
  if (value >= SCORE_BANDS.mid) return "mid";
  return "low";
}

/** Tailwind text class per band: the `*-text` tokens keep light-theme contrast above 4.5:1. */
export const SCORE_TEXT_CLASS: Record<ScoreTone, string> = {
  top: "text-score-top-text",
  good: "text-score-good-text",
  mid: "text-score-mid-text",
  low: "text-score-low-text",
};

/** Whole numbers show without decimals ("84"), fractions with one ("84.5"). */
export function formatRank(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
