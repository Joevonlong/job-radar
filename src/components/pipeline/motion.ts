/**
 * Motion of the board (docs/design/tokens.md "看板卡片"): a lifted card tilts 3 degrees and a dropped one settles with
 * the spring curve. Reduced motion: no tilt, no spring, no travel.
 */

/** Tilt of a lifted card, in degrees (design: rotate(-3deg)). */
export const LIFT_TILT_DEG = -3;
/** Offset of a lifted card, in px: it moves up-left while its shadow grows to `shadow-e5`. */
export const LIFT_SHIFT_PX = -3;

/** `--dur-slow` (360 ms) with the `--ease-spring` curve (0.34, 1.56, 0.64, 1): the overshoot is the "spring". */
const SETTLE = { duration: 0.36, ease: [0.34, 1.56, 0.64, 1] } as const;
/** `--dur-base` (220 ms), same curve: the tilt when a card is picked up. */
const LIFT = { duration: 0.22, ease: [0.34, 1.56, 0.64, 1] } as const;

export function settleTransition(reduced: boolean) {
  return reduced ? { duration: 0 } : SETTLE;
}

export function liftTransition(reduced: boolean) {
  return reduced ? { duration: 0 } : LIFT;
}
