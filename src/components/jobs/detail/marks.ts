import { signalColorClasses, type SignalColor } from "@/lib/signals/palette";

/**
 * Highlight classes of a signal category (by its palette colour): the same marker in the JD text, in its legend and on
 * a quote's term. Solid fills like the design's `mark.t1`.
 */
export function markClass(color: SignalColor): string {
  return signalColorClasses(color).solid;
}

/** A breakdown quote is marked with a dotted underline, no fill, so it never competes with a signal's colour block. */
export const BREAKDOWN_MARK_CLASS = "underline decoration-dotted decoration-ink-3 underline-offset-2";

/** An AI trap in the JD: a 2px dashed `--bad` frame on the soft fill, so it reads as "not meant for you" rather than as a signal. */
export const TRAP_MARK_CLASS = "rounded-cell bg-soft text-inherit outline-[length:var(--bw)] outline-dashed outline-bad -outline-offset-1 px-0.5";

/** A visa sponsorship quote: a dashed underline, no fill (the breakdown's is dotted, a trap's is a frame). */
export const VISA_MARK_CLASS = "underline decoration-dashed decoration-ink-2 decoration-2 underline-offset-[3px]";

/** A ghost job quote ("we are always looking for…"): a wavy `--warn` underline, no fill (visa is dashed, breakdown dotted). */
export const GHOST_MARK_CLASS = "underline decoration-wavy decoration-warn decoration-2 underline-offset-[3px]";

/** A scoring reason's JD quote: a thin solid underline, no fill (breakdown dotted, visa dashed, ghost wavy, trap a frame). */
export const EVIDENCE_MARK_CLASS = "underline decoration-solid decoration-ink-2 decoration-1 underline-offset-[3px]";

/**
 * What the JD panel highlights: a signal category id, a quote of the job breakdown, an AI trap, a visa, ghost job or scoring
 * reason quote (`breakdown` and `trap` are reserved ids; `:visa`, `:ghost` and `:evidence` cannot be category ids; a signal wins
 * when both are the same text).
 */
export type JdQuoteTier = string;
export const BREAKDOWN_QUOTE = "breakdown";
export const TRAP_QUOTE = "trap";
export const VISA_QUOTE = ":visa";
export const GHOST_QUOTE = ":ghost";
export const EVIDENCE_QUOTE = ":evidence";

/** Id of the `mark` the JD shows for the signal quote with this index (position in the page's `quotes` list). */
export function jdMarkId(index: number): string {
  return `jd-quote-${index}`;
}

/** The event a signal tag sends to the JD panel: show the original text, scroll to the mark, flash it. */
export const JD_JUMP_EVENT = "jr:jd-jump";

export interface JdJumpDetail {
  index: number;
}

export function requestJdJump(index: number): void {
  window.dispatchEvent(new CustomEvent<JdJumpDetail>(JD_JUMP_EVENT, { detail: { index } }));
}

/** How long the mark keeps its outline when the user asked for less motion (otherwise the flash animation sets the time). */
export const FLASH_STILL_MS = 1600;
