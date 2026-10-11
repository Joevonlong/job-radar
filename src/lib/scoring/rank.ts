/** Rank values are stored with two decimals (`scores.rank_value`). */
const roundTo2 = (value: number): number => Math.round(value * 100) / 100;

/** The match score after the German deduction, kept within 0..100. */
export function finalMatchScore(aiScore: number, germanPenalty: number): number {
  return Math.min(100, Math.max(0, Math.round(aiScore - germanPenalty)));
}

/**
 * Rank value = match score + min(signal bonus, cap). The signal bonus is
 * written by the signals step (0 until there are signals); the cap is interests.yaml `bonus_cap`. It is the
 * one place this formula lives, so the signals recomputation after a weight change uses it too.
 */
export function computeRankValue(matchScore: number, signalBonus: number, bonusCap: number): number {
  return roundTo2(matchScore + Math.min(Math.max(0, signalBonus), Math.max(0, bonusCap)));
}
