import type { SignalColor } from "@/lib/signals/palette";

/** One category that counts towards the bonus, as the bar draws it. */
export interface CapEntry {
  /** Category id. */
  id: string;
  points: number;
  color: SignalColor;
  /** What the piece prints (the category's code, else its icon); null = nothing. */
  code: string | null;
  label: string;
}

export interface CapPiece extends CapEntry {
  /** Points this category is worth. */
  points: number;
  /** Part of them below the cap (counted in the rank value). */
  counted: number;
  /** Part of them above the cap (hatched: brings nothing). */
  over: number;
  /** Share of the bar this piece takes, 0-100. */
  width: number;
  /** Share of the piece that is above the cap, 0-100 (the hatched end). */
  overShare: number;
}

export interface CapBar {
  pieces: CapPiece[];
  /** Sum of all pieces. */
  total: number;
  /** What counts: `min(total, cap)`. Always equals the signal bonus in the rank value. */
  counted: number;
  /** Where the cap line stands, 0-100. */
  capAt: number;
  capped: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The stacked bar under "pay and benefits": one piece per category that counts, in category order, the part above `cap`
 * hatched. The bar is as long as the larger of the total and the cap, so a total under the cap leaves visible room.
 */
export function capBar(tiers: readonly CapEntry[], cap: number): CapBar {
  const total = round2(tiers.reduce((sum, t) => sum + Math.max(0, t.points), 0));
  const scale = Math.max(total, cap, 0);
  let before = 0;
  const pieces = tiers
    .filter((t) => t.points > 0)
    .map((t): CapPiece => {
      const counted = round2(Math.max(0, Math.min(t.points, cap - before)));
      before += t.points;
      return {
        ...t,
        counted,
        over: round2(t.points - counted),
        width: scale === 0 ? 0 : (t.points / scale) * 100,
        overShare: (round2(t.points - counted) / t.points) * 100,
      };
    });
  return { pieces, total, counted: round2(Math.min(total, cap)), capAt: scale === 0 ? 0 : (Math.max(0, cap) / scale) * 100, capped: total > cap };
}
