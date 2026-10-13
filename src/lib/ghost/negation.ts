/**
 * The negation test of an evergreen hit inside its piece: a negation cue among the words before it in its clause, inside it, or
 * after it in its clause. Every hit of a piece is tested against one index of the piece's words and clause breaks, read once, so
 * the time stays linear in the length of the piece (re-reading the text around every hit takes the square of the hit count).
 *
 * The words of a window are those of its slice read alone. Where the window starts inside one of the piece's words (in "x'y'z",
 * whose words are "x'y" and "z", a window from "y" reads "y'z"), the slice reads a chain of words of its own, each from the end of
 * the one before, until a word starts where one of the piece's words starts, or the run of word characters and apostrophes ends:
 * from there on it reads the piece's words, whose cues are counted once. Chains are read only as far as a window needs, and what
 * they hold is kept for the windows of the next hits (the words after a clause's start; for each place in a chain, whether a cue
 * follows it to the clause's end; whether the word that a clause's end cuts is a cue), so a run is not read again for every hit.
 */
import type { CompiledGhostRules } from "./rules";

/** A word: letters and digits, "don't" as one. */
export const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
/** A word read where it starts (on a slice that starts there). */
const WORD_HERE = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/uy;
/** The runs of word characters and apostrophes: a word never reaches past the end of its run. */
const RUN = /[\p{L}\p{N}'’]+/gu;
const APOSTROPHE = /['’]/u;

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

/**
 * The words read so far from one start inside a word of the piece (the start of the clause of the current hits), up to where they
 * meet the piece's words.
 */
interface Tail {
  at: number;
  /** The words read, in order (each one whole: the end of no window cut it). */
  starts: number[];
  ends: number[];
  /** `cuesBefore[i]`: how many of the first `i` of them are negation cues. */
  cuesBefore: number[];
  /** Where reading goes on. */
  next: number;
  /** The piece's word where they meet the piece's words (from there on the slices read as the piece), -1 when not reached yet. */
  piece: number;
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
  /** Where a word's apostrophe is ("don't"), -1 when it has none. */
  wordJoins: number[];
  /** `cuesBefore[i]`: how many of the first `i` words are negation cues. */
  cuesBefore: number[];
  runEnds: number[];
  /** The words after the last start inside a word that a window before a hit had (only one: the hits come in text order). */
  tail: Tail | null;
  /** For the places in a chain of words where a clause's rest was read: whether a cue follows to the end, for one end. */
  rest: { end: number; cueAfter: Map<number, boolean> } | null;
  /** Whether the part before it of the piece's word that a window's end cuts is a cue, by the end. */
  rightAt: Map<number, boolean>;
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
  const index: NegationIndex = { text, cues: rules.negationCues, breakEnds, breakStarts, wordStarts: [], wordEnds: [], wordJoins: [], cuesBefore: [0], runEnds: [], tail: null, rest: null, rightAt: new Map() };
  let count = 0;
  for (const match of text.matchAll(WORD)) {
    index.wordStarts.push(match.index);
    index.wordEnds.push(match.index + match[0].length);
    const join = match[0].search(APOSTROPHE);
    index.wordJoins.push(join === -1 ? -1 : match.index + join);
    if (isCue(match[0], rules.negationCues)) count += 1;
    index.cuesBefore.push(count);
  }
  for (const match of text.matchAll(RUN)) index.runEnds.push(match.index + match[0].length);
  return index;
}

const isCue = (word: string, cues: readonly RegExp[]): boolean => cues.some((cue) => cue.test(word));

const isApostrophe = (code: number): boolean => code === 0x27 || code === 0x2019;

/** The word of a slice ending at `end` that starts at `start` and runs past `end` in the piece: its part before `end`. */
function cutWord(text: string, start: number, end: number): string {
  // "don'" reads "don"; "don't" cut anywhere else reads all of what is left of it
  return text.slice(start, isApostrophe(text.charCodeAt(end - 1)) ? end - 1 : end);
}

/** A word of a slice that the piece reads otherwise (it starts inside one of the piece's words). */
interface ChainWord {
  start: number;
  /** The slice's end when the slice's end cut it. */
  end: number;
  word: string;
  /** False: the slice's end cut it (what follows in the piece would belong to it). */
  whole: boolean;
}

/**
 * Where the next word of a slice ending at `end` starts, read from `at`: `{ piece }` when it is the piece's word `piece` (from there
 * on the slice reads the piece's words), `{ start, inside }` when it starts inside the piece's word `inside`, null when none does
 * before `end`.
 */
function nextWord(index: NegationIndex, at: number, end: number): { piece: number } | { start: number; inside: number } | null {
  if (at >= end) return null;
  const k = lowerBound(index.wordEnds, at + 1);
  if (k === index.wordStarts.length) return null;
  const wordStart = index.wordStarts[k] as number;
  if (wordStart >= at) return wordStart < end ? { piece: k } : null;
  // inside word k: on a letter or digit, or on its apostrophe (then the letter after it)
  const start = at === index.wordJoins[k] ? at + 1 : at;
  return start < end ? { start, inside: k } : null;
}

/** The word of the slice ending at `end` that starts at `start`, inside the piece's word `inside`. */
function readWord(index: NegationIndex, start: number, inside: number, end: number): ChainWord {
  const { text } = index;
  const join = index.wordJoins[inside] as number;
  if (join === -1 || start < join) {
    // before the apostrophe: the same letters and digits, and the same apostrophe and letters, as the piece's word
    const wordEnd = index.wordEnds[inside] as number;
    if (wordEnd <= end) return { start, end: wordEnd, word: text.slice(start, wordEnd), whole: true };
    return { start, end, word: cutWord(text, start, end), whole: false };
  }
  // after it: the letters may go on into the digits, or the apostrophe and letters, after the piece's word ("x'y'z" from "y")
  WORD_HERE.lastIndex = 0;
  const word = WORD_HERE.exec(text.slice(start, end))?.[0] ?? "";
  const wordEnd = start + word.length;
  // it is whole when the slice shows what follows it: a character that is not an apostrophe, or an apostrophe and one more
  const whole = wordEnd < end - 1 || (wordEnd === end - 1 && !isApostrophe(text.charCodeAt(wordEnd)));
  return { start, end: whole ? wordEnd : end, word, whole };
}

function tailAt(index: NegationIndex, at: number): Tail {
  if (index.tail?.at === at) return index.tail;
  const k = lowerBound(index.wordEnds, at + 1);
  const inside = k < index.wordStarts.length && (index.wordStarts[k] as number) < at;
  index.tail = { at, starts: [], ends: [], cuesBefore: [0], next: at, piece: inside ? -1 : k };
  return index.tail;
}

/** Reads the tail's words up to `end`; returns the word that `end` cuts when reading stopped at it. */
function extend(index: NegationIndex, tail: Tail, end: number): ChainWord | null {
  while (tail.piece === -1 && tail.next < end) {
    const next = nextWord(index, tail.next, end);
    if (next === null) return null;
    if ("piece" in next) {
      tail.piece = next.piece;
      return null;
    }
    const word = readWord(index, next.start, next.inside, end);
    if (!word.whole) return word;
    tail.starts.push(word.start);
    tail.ends.push(word.end);
    tail.cuesBefore.push((tail.cuesBefore[tail.cuesBefore.length - 1] as number) + (isCue(word.word, index.cues) ? 1 : 0));
    tail.next = word.end;
  }
  return null;
}

/**
 * The words of the slice from the tail's start to `end`, in order: the tail's first `chain` words, then `cut` (a word that `end`
 * cuts before the slice meets the piece's words), then the piece's words `lo` to `hi` (exclusive), then the piece's word `hi` cut
 * by `end` (`right`).
 */
interface Parts {
  chain: number;
  cut: string | null;
  lo: number;
  hi: number;
  right: boolean;
}

function partsOf(index: NegationIndex, tail: Tail, end: number): Parts {
  const cut = extend(index, tail, end);
  const chain = lowerBound(tail.ends, end + 1);
  // read before up to a later end (the windows asked out of text order)
  if (chain < tail.starts.length && (tail.starts[chain] as number) < end) return { chain, cut: cutWord(index.text, tail.starts[chain] as number, end), lo: 0, hi: 0, right: false };
  if (cut !== null || tail.piece === -1) return { chain, cut: cut?.word ?? null, lo: 0, hi: 0, right: false };
  const lo = tail.piece;
  const hi = Math.max(lo, lowerBound(index.wordEnds, end + 1));
  return { chain, cut: null, lo, hi, right: hi < index.wordStarts.length && (index.wordStarts[hi] as number) < end };
}

const sizeOf = (parts: Parts): number => parts.chain + (parts.cut === null ? 0 : 1) + (parts.hi - parts.lo) + (parts.right ? 1 : 0);

/** Whether one of the words `first` to `last` (exclusive) of the slice from the tail's start to `end` is a negation cue. */
function cueAmong(index: NegationIndex, tail: Tail, parts: Parts, end: number, first: number, last: number): boolean {
  if (last <= first) return false;
  const chainLast = Math.min(last, parts.chain);
  if (chainLast > first && (tail.cuesBefore[chainLast] as number) > (tail.cuesBefore[first] as number)) return true;
  let offset = parts.chain;
  if (parts.cut !== null) {
    if (first <= offset && offset < last && isCue(parts.cut, index.cues)) return true;
    offset += 1;
  }
  const a = Math.max(first, offset) - offset;
  const b = Math.min(last, offset + parts.hi - parts.lo) - offset;
  if (b > a && (index.cuesBefore[parts.lo + b] as number) > (index.cuesBefore[parts.lo + a] as number)) return true;
  offset += parts.hi - parts.lo;
  return parts.right && first <= offset && offset < last && isCue(cutWord(index.text, index.wordStarts[parts.hi] as number, end), index.cues);
}

/** Whether one of the last `count` words of the slice from `start` to `end` is a negation cue. */
function cueBefore(index: NegationIndex, start: number, end: number, count: number): boolean {
  const tail = tailAt(index, start);
  if (tail.piece === -1) {
    // the piece's words from the end of the run that `start` cuts on are the slice's: when they are enough, the tail is not read
    const { wordStarts, wordEnds, runEnds, cuesBefore } = index;
    const from = lowerBound(wordStarts, runEnds[lowerBound(runEnds, start + 1)] as number);
    const hi = lowerBound(wordEnds, end + 1);
    const right = hi >= from && hi < wordStarts.length && (wordStarts[hi] as number) < end;
    if (Math.max(0, hi - from) + (right ? 1 : 0) >= count) {
      if (right && isCue(cutWord(index.text, wordStarts[hi] as number, end), index.cues)) return true;
      const take = count - (right ? 1 : 0);
      return take > 0 && (cuesBefore[hi] as number) > (cuesBefore[hi - take] as number);
    }
  }
  const parts = partsOf(index, tail, end);
  const size = sizeOf(parts);
  return cueAmong(index, tail, parts, end, Math.max(0, size - count), size);
}

/** Whether the part before `end` of the piece's word `k` that `end` cuts is a cue; read once for each end. */
function rightAt(index: NegationIndex, k: number, end: number): boolean {
  let cue = index.rightAt.get(end);
  if (cue === undefined) index.rightAt.set(end, (cue = isCue(cutWord(index.text, index.wordStarts[k] as number, end), index.cues)));
  return cue;
}

/**
 * Whether one of the first `count` words (all of them: Infinity) of the slice from `start` to `end` is a negation cue. `cueAfter`:
 * for the places in the chain read from `start`, whether a cue follows to `end` (the rest of a clause; read, and kept). `shared`:
 * the cut word at `end` is the same for many windows (the end of a clause), so it is read once.
 */
function cueAhead(index: NegationIndex, start: number, end: number, count: number, cueAfter: Map<number, boolean> | null, shared: boolean): boolean {
  const walked: number[] = [];
  let found = false;
  let read = 0;
  for (let at = start; read < count; ) {
    const next = nextWord(index, at, end);
    if (next === null) break;
    if ("piece" in next) {
      const { wordStarts, wordEnds, cuesBefore } = index;
      const hi = Math.max(next.piece, lowerBound(wordEnds, end + 1));
      const take = Math.min(count - read, hi - next.piece);
      found = (cuesBefore[next.piece + take] as number) > (cuesBefore[next.piece] as number);
      if (!found && take < count - read && hi < wordStarts.length && (wordStarts[hi] as number) < end) {
        found = shared ? rightAt(index, hi, end) : isCue(cutWord(index.text, wordStarts[hi] as number, end), index.cues);
      }
      break;
    }
    const known = cueAfter?.get(next.start);
    if (known !== undefined) {
      found = known;
      break;
    }
    const word = readWord(index, next.start, next.inside, end);
    walked.push(word.start);
    read += 1;
    if (isCue(word.word, index.cues)) {
      found = true;
      break;
    }
    if (!word.whole) break;
    at = word.end;
  }
  // every place walked has no cue before the one that decided
  if (cueAfter !== null) for (const at of walked) cueAfter.set(at, found);
  return found;
}

/**
 * The words of `text.slice(start, end)` as the negation test reads them (the same as reading that slice alone).
 * @internal for tests
 */
export function windowWords(index: NegationIndex, start: number, end: number): string[] {
  if (end <= start) return [];
  const tail = tailAt(index, start);
  const parts = partsOf(index, tail, end);
  const words: string[] = [];
  for (let i = 0; i < parts.chain; i++) words.push(index.text.slice(tail.starts[i], tail.ends[i]));
  if (parts.cut !== null) words.push(parts.cut);
  for (let k = parts.lo; k < parts.hi; k++) words.push(index.text.slice(index.wordStarts[k], index.wordEnds[k]));
  if (parts.right) words.push(cutWord(index.text, index.wordStarts[parts.hi] as number, end));
  return words;
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
 * start of one at or after its end; words are read as on the slices before, inside and after the hit alone. The breaks are
 * matched over the whole piece (read once), so a lookaround in one may read into the hit: a break that only matches with (or
 * without) the hit's own text around it ends the clause where it matches in the whole piece. Asked for the hits of a piece in
 * text order, the time stays linear in its length; asked in any order, the answers are the same.
 */
export function negatedInClause(index: NegationIndex, from: number, to: number, reach: NegationReach): boolean {
  if (index.cues.length === 0) return false;
  const ends = lowerBound(index.breakEnds, from + 1);
  const clauseStart = ends === 0 ? 0 : (index.breakEnds[ends - 1] as number);
  const next = lowerBound(index.breakStarts, to);
  const clauseEnd = next < index.breakStarts.length ? (index.breakStarts[next] as number) : index.text.length;
  if (reach.before > 0 && from > clauseStart && cueBefore(index, clauseStart, from, reach.before)) return true;
  if (cueAhead(index, from, to, Infinity, null, false)) return true;
  if (reach.after === "clause") {
    if (index.rest?.end !== clauseEnd) index.rest = { end: clauseEnd, cueAfter: new Map() };
    return cueAhead(index, to, clauseEnd, Infinity, index.rest.cueAfter, true);
  }
  return reach.after > 0 && cueAhead(index, to, clauseEnd, reach.after, null, true);
}
