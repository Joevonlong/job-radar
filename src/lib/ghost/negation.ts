/**
 * The negation test of an evergreen hit inside its piece: a negation cue among the words before it in its clause, inside it, or
 * after it in its clause. Every hit of a piece is tested against one index of the piece's words and clause breaks, read once, so
 * the time stays linear in the length of the piece (re-reading the text around every hit takes the square of the hit count).
 */
import type { CompiledGhostRules } from "./rules";

/** A word: letters and digits, "don't" as one. */
export const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
/** The runs of word characters and apostrophes: a word never reaches past the end of its run. */
const RUN = /[\p{L}\p{N}'’]+/gu;

export const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);

/** The first index in the ascending `values` whose value is at least `value` (`values.length` when none). */
export function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A piece's text read once for the negation test of its hits. */
export interface NegationIndex {
  text: string;
  cues: readonly RegExp[];
  /** Where the `clause_breaks` matches end, and where they start, each ascending. */
  breakEnds: number[];
  breakStarts: number[];
  /** The piece's words, in order. */
  wordStarts: number[];
  wordEnds: number[];
  /** `cuesBefore[i]`: how many of the first `i` words are negation cues. */
  cuesBefore: number[];
  runStarts: number[];
  runEnds: number[];
}

export function negationIndex(text: string, rules: Pick<CompiledGhostRules, "clauseBreaks" | "negationCues">): NegationIndex {
  const breakEnds: number[] = [];
  const breakStarts: number[] = [];
  for (const re of rules.clauseBreaks) {
    for (const match of text.matchAll(re)) {
      breakStarts.push(match.index);
      breakEnds.push(match.index + match[0].length);
    }
  }
  breakEnds.sort((a, b) => a - b);
  breakStarts.sort((a, b) => a - b);
  const index: NegationIndex = { text, cues: rules.negationCues, breakEnds, breakStarts, wordStarts: [], wordEnds: [], cuesBefore: [0], runStarts: [], runEnds: [] };
  let count = 0;
  for (const match of text.matchAll(WORD)) {
    index.wordStarts.push(match.index);
    index.wordEnds.push(match.index + match[0].length);
    if (isCue(match[0], rules.negationCues)) count += 1;
    index.cuesBefore.push(count);
  }
  for (const match of text.matchAll(RUN)) {
    index.runStarts.push(match.index);
    index.runEnds.push(match.index + match[0].length);
  }
  return index;
}

const isCue = (word: string, cues: readonly RegExp[]): boolean => cues.some((cue) => cue.test(word));

/**
 * The words of `text.slice(a, b)`, as read on that slice alone: `left` (read on their own when `a` cuts a word, up to the end of its
 * run or `b`), then the index's words `lo` to `hi` (exclusive), then `right` (the word that `b` cuts, as far as it goes).
 */
interface Window {
  left: string[];
  lo: number;
  hi: number;
  right: string[];
}

function windowOf(index: NegationIndex, a: number, b: number): Window {
  const { text, wordStarts, wordEnds } = index;
  if (b <= a) return { left: [], lo: 0, hi: 0, right: [] };
  let from = a;
  let left: string[] = [];
  // a cuts a word: what is left of it reads differently ("x'don't" cut after "x'" is "don't"), up to the end of its run (where the
  // words of the slice and of the whole piece are the same again)
  const cut = lowerBound(wordEnds, a + 1);
  if (cut < wordStarts.length && (wordStarts[cut] as number) < a) {
    const run = lowerBound(index.runEnds, a + 1);
    from = Math.min(b, index.runEnds[run] as number);
    left = wordsOf(text.slice(a, from));
  }
  const lo = lowerBound(wordStarts, from);
  const hi = Math.max(lo, lowerBound(wordEnds, b + 1));
  // b cuts a word: its part before b ("don't" cut after "don'" is "don")
  const right = hi < wordStarts.length && (wordStarts[hi] as number) < b && hi >= lo && (wordStarts[hi] as number) >= from ? wordsOf(text.slice(wordStarts[hi] as number, b)) : [];
  return { left, lo, hi, right };
}

const sizeOf = (window: Window): number => window.left.length + (window.hi - window.lo) + window.right.length;

/** Whether one of the words `first` to `last` (exclusive) of a window is a negation cue. */
function cueAmong(index: NegationIndex, window: Window, first: number, last: number): boolean {
  if (last <= first) return false;
  const left = window.left.length;
  const middle = window.hi - window.lo;
  for (let i = first; i < Math.min(last, left); i++) if (isCue(window.left[i] as string, index.cues)) return true;
  const a = Math.max(first, left) - left;
  const b = Math.min(last, left + middle) - left;
  if (b > a && (index.cuesBefore[window.lo + b] as number) > (index.cuesBefore[window.lo + a] as number)) return true;
  for (let i = Math.max(first, left + middle); i < last; i++) if (isCue(window.right[i - left - middle] as string, index.cues)) return true;
  return false;
}

export interface NegationReach {
  /** Words before the hit, within its clause. */
  before: number;
  /** Words after the hit, within its clause, or the whole rest of its clause. */
  after: number | "clause";
}

/**
 * A negation cue among the `reach.before` words before the hit at `from`…`to` (offsets in the index's text), inside it, or after
 * it (`reach.after`). Its clause starts at the furthest end of a `clause_breaks` match at or before the hit and ends at the first
 * start of one at or after its end; words are read as on the slices before, inside and after the hit alone.
 */
export function negatedInClause(index: NegationIndex, from: number, to: number, reach: NegationReach): boolean {
  if (index.cues.length === 0) return false;
  const ends = lowerBound(index.breakEnds, from + 1);
  const clauseStart = ends === 0 ? 0 : (index.breakEnds[ends - 1] as number);
  const next = lowerBound(index.breakStarts, to);
  const clauseEnd = next < index.breakStarts.length ? (index.breakStarts[next] as number) : index.text.length;
  if (reach.before > 0) {
    const before = windowOf(index, clauseStart, from);
    const size = sizeOf(before);
    if (cueAmong(index, before, Math.max(0, size - reach.before), size)) return true;
  }
  const inside = windowOf(index, from, to);
  if (cueAmong(index, inside, 0, sizeOf(inside))) return true;
  const after = windowOf(index, to, clauseEnd);
  const size = sizeOf(after);
  return cueAmong(index, after, 0, reach.after === "clause" ? size : Math.min(size, reach.after));
}
