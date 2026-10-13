/**
 * The negation test of an `offered` hit inside its segment: a negation cue inside it, among the words before it, or among the
 * words after it in its clause. The words around every hit are found in one index of the segment's words and clause breaks, read
 * once, so the time stays linear in the length of the segment (re-reading the text before and after every hit took the square of
 * the hit count). Pure (no node modules): the job pages' client code reaches it through the deal-breaker filter.
 *
 * Words are read as on the slices before, inside and after the hit alone: a word cut by the hit's start counts only up to it, the
 * text after the hit is read from the hit's end (the rest of a cut word is a word of its own). The clause breaks are matched over
 * the whole segment, so a lookbehind, `^` or `\b` in one sees the hit's own text (docs/market-packs.md lists what that changes).
 * The time is linear when the patterns end at a word boundary (the packs' all do): a hit inside one long word reads that word.
 */
import type { CompiledVisaRules } from "./rules";

/** A word: letters and digits, "don't" as one. */
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
/** The same, read with `exec` from a given offset (its own copy: `lastIndex` is set before each read). */
const WORD_SCAN = new RegExp(WORD.source, "gu");

const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);

const isCue = (word: string, cues: readonly RegExp[]): boolean => cues.some((cue) => cue.test(word));

/** The first index in the ascending `values` whose value is at least `value` (`values.length` when none). */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface NegationReach {
  /** Words before the hit, from the segment's start (clause breaks do not stop them). */
  before: number;
  /** Words after the hit, up to the end of its clause. */
  after: number;
}

/** A segment's text read once for the negation test of its hits. */
export interface NegationIndex {
  text: string;
  cues: readonly RegExp[];
  /** Where the `clause_breaks` matches start (empty matches too), ascending. */
  breakStarts: number[];
  /** The segment's words, in order. */
  wordStarts: number[];
  wordEnds: number[];
  /** Whether word `i` is a negation cue: 0 not tested yet, 1 yes, 2 no (each word is tested at most once). */
  cueFlag: Int8Array;
}

export function negationIndex(text: string, rules: Pick<CompiledVisaRules, "clauseBreaks" | "negationCues">): NegationIndex {
  const breakStarts: number[] = [];
  for (const re of rules.clauseBreaks) for (const match of text.matchAll(re)) breakStarts.push(match.index);
  breakStarts.sort((a, b) => a - b);
  const wordStarts: number[] = [];
  const wordEnds: number[] = [];
  for (const match of text.matchAll(WORD)) {
    wordStarts.push(match.index);
    wordEnds.push(match.index + match[0].length);
  }
  return { text, cues: rules.negationCues, breakStarts, wordStarts, wordEnds, cueFlag: new Int8Array(wordStarts.length) };
}

/** Whether word `i` of the index is a negation cue, tested once. */
function cueAt(index: NegationIndex, i: number): boolean {
  let flag = index.cueFlag[i];
  if (flag === 0) {
    flag = isCue(index.text.slice(index.wordStarts[i] as number, index.wordEnds[i] as number), index.cues) ? 1 : 2;
    index.cueFlag[i] = flag;
  }
  return flag === 1;
}

/** A negation cue among the words of the hit `text.slice(from, to)` itself: needs no index. */
export function cueInside(text: string, from: number, to: number, cues: readonly RegExp[]): boolean {
  if (to <= from || cues.length === 0) return false;
  for (const match of text.slice(from, to).matchAll(WORD)) if (isCue(match[0], cues)) return true;
  return false;
}

/** A negation cue among the last `count` words of `text.slice(0, from)`. */
function cueBefore(index: NegationIndex, from: number, count: number): boolean {
  const { text, wordStarts, wordEnds } = index;
  let k = lowerBound(wordEnds, from + 1);
  let left = count;
  // `from` cuts word k: its part before `from` is read on its own ("don't" cut after "don" is "don"), and is not the indexed word
  if (k < wordStarts.length && (wordStarts[k] as number) < from) {
    const cut = wordsOf(text.slice(wordStarts[k] as number, from));
    for (let i = cut.length - 1; i >= 0 && left > 0; i--, left--) if (isCue(cut[i] as string, index.cues)) return true;
  }
  for (k -= 1; k >= 0 && left > 0; k--, left--) if (cueAt(index, k)) return true;
  return false;
}

/** A negation cue among the first `count` words of `text.slice(to, end)`, where `end` is the first clause break at or after `to`. */
function cueAfter(index: NegationIndex, to: number, count: number): boolean {
  const { text, breakStarts, wordStarts, wordEnds } = index;
  const next = lowerBound(breakStarts, to);
  const end = next < breakStarts.length ? (breakStarts[next] as number) : text.length;
  // read from `to`, not from the index: the rest of a word cut at `to` is a word of its own ("ab'cd'ef" cut after "ab'" reads
  // "cd'ef"), and the words after it may then differ from the indexed ones too. Only a word read with the same start and end as
  // an indexed one takes the index's cue flag.
  WORD_SCAN.lastIndex = to;
  let k = lowerBound(wordStarts, to);
  let left = count;
  while (left > 0) {
    const match = WORD_SCAN.exec(text);
    if (match === null || match.index >= end) return false;
    const wordEnd = match.index + match[0].length;
    if (wordEnd > end) {
      // the clause ends inside this word: its part before the break
      for (const word of wordsOf(text.slice(match.index, end)).slice(0, left)) if (isCue(word, index.cues)) return true;
      return false;
    }
    while (k < wordStarts.length && (wordStarts[k] as number) < match.index) k += 1;
    const indexed = k < wordStarts.length && wordStarts[k] === match.index && wordEnds[k] === wordEnd;
    if (indexed ? cueAt(index, k) : isCue(match[0], index.cues)) return true;
    left -= 1;
  }
  return false;
}

/**
 * A negation cue among the `reach.before` words before the hit at `from`…`to` (offsets in the index's text) or the `reach.after`
 * words after it in its clause. The words inside the hit are `cueInside`'s, which the caller asks first.
 */
export function negatedInWindow(index: NegationIndex, from: number, to: number, reach: NegationReach): boolean {
  if (index.cues.length === 0) return false;
  if (reach.before > 0 && cueBefore(index, from, reach.before)) return true;
  return reach.after > 0 && cueAfter(index, to, reach.after);
}
