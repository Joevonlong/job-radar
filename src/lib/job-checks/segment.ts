/**
 * Cuts a JD into the pieces the job checks judge one by one: sentences, list items, and a short heading line together with the line
 * after it ("Visa sponsorship:" / "## Visa sponsorship" / "Visa sponsorship" + "Not available"). Every piece is a verbatim range of
 * the text (C7).
 */

/** A piece of the text: `text === description.slice(start, end)`. */
export interface TextSegment {
  text: string;
  start: number;
  end: number;
  /** The piece is (part of) a line that starts with a list marker ("- ", "• ", "2) "); a "#" heading is not a list item. */
  listItem: boolean;
}

export interface SegmentOptions {
  /** Abbreviations whose dot does not end a sentence (lower case, without the final dot); empty or missing means the defaults. */
  abbreviations?: readonly string[];
  /** Longest heading line (trimmed, without its "#" marker) that is read together with the next line. */
  headingMaxChars: number;
  /**
   * Only cut the lines (or heading + next line pairs) for which this returns true, given the range they cover; the others give no
   * segment at all. A check passes its cheap prefilter here so a long JD is not cut into sentences it would skip anyway.
   */
  keep?: (start: number, end: number) => boolean;
}

/** Abbreviations whose dot does not end a sentence, used when the caller passes none (lower case, without the final dot). */
export const DEFAULT_ABBREVIATIONS: readonly string[] = ["e.g", "i.e", "etc", "incl", "approx", "vs", "z.b", "ca", "inkl", "bzw", "usw", "u.a", "d.h", "ggf"];

// sticky: tried at the line's first character without copying the line
const LIST_MARKER = /(?:[-*•–·]\s+|\d{1,3}[.)]\s+)/uy;
const HEADING_MARKER = /#{1,6}\s+/uy;
/** A line ending in one of these is a sentence (or a list), not a heading without a colon. */
const END_PUNCTUATION = /[.!?;,)\]"'“”»]$/u;
const SPACE = /\s/u;
const LOWER_START = /^\p{Ll}/u;

interface Line {
  /** Where the line's content starts (after leading spaces and a list marker) and ends (before trailing spaces). */
  start: number;
  end: number;
  /** The line starts with a list marker. */
  listItem: boolean;
  /** The line starts with a markdown heading marker ("## "). */
  markdownHeading: boolean;
}

/** Length of the sticky `marker` matched at `start` (within the line), or 0. */
function markerAt(marker: RegExp, text: string, start: number, end: number): number {
  marker.lastIndex = start;
  const match = marker.exec(text);
  return match !== null && start + match[0].length <= end ? match[0].length : 0;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  while (at <= text.length) {
    const newline = text.indexOf("\n", at);
    let end = newline === -1 ? text.length : newline;
    let start = at;
    while (start < end && SPACE.test(text.charAt(start))) start += 1;
    while (end > start && SPACE.test(text.charAt(end - 1))) end -= 1;
    const marker = markerAt(LIST_MARKER, text, start, end);
    const heading = marker === 0 ? markerAt(HEADING_MARKER, text, start, end) : 0;
    const skip = marker + heading;
    if (skip > 0) {
      start += skip;
      while (start < end && SPACE.test(text.charAt(start))) start += 1;
    }
    if (end > start) lines.push({ start, end, listItem: marker > 0, markdownHeading: heading > 0 });
    if (newline === -1) break;
    at = newline + 1;
  }
  return lines;
}

/** The word right before the dot at `dot` (back to the previous space or opening bracket), lower case. */
function wordBefore(text: string, from: number, dot: number): string {
  let i = dot;
  while (i > from && !SPACE.test(text.charAt(i - 1)) && !"([{\"'„“".includes(text.charAt(i - 1))) i -= 1;
  return text.slice(i, dot).toLowerCase();
}

function isAbbreviation(word: string, abbreviations: ReadonlySet<string>): boolean {
  if (word.length === 0) return false;
  if (abbreviations.has(word)) return true;
  // a single letter ("z. B.", initials) never ends a sentence
  return /^\p{L}$/u.test(word);
}

/** Sentence ranges of `text[start, end)`: a sentence ends at ".", "!" or "?" followed by a space, unless the dot ends an abbreviation. */
function sentencesOf(text: string, line: Line, abbreviations: ReadonlySet<string>): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let from = line.start;
  for (let i = line.start; i < line.end; i += 1) {
    const char = text.charAt(i);
    if (char !== "." && char !== "!" && char !== "?") continue;
    let stop = i + 1;
    while (stop < line.end && ".!?".includes(text.charAt(stop))) stop += 1;
    if (stop < line.end && !SPACE.test(text.charAt(stop))) {
      i = stop - 1;
      continue;
    }
    let next = stop;
    while (next < line.end && SPACE.test(text.charAt(next))) next += 1;
    const abbreviation = char === "." && stop === i + 1 && isAbbreviation(wordBefore(text, from, i), abbreviations);
    // "… etc. and more": a lower-case word after a dot does not start a sentence
    if (!abbreviation && !(char === "." && LOWER_START.test(text.slice(next, next + 1)))) {
      out.push({ start: from, end: stop });
      from = next;
    }
    i = stop - 1;
  }
  if (from < line.end) out.push({ start: from, end: line.end });
  return out;
}

type Range = { start: number; end: number };

/**
 * Cuts `description` into segments (in text order, not overlapping). A heading line is joined with the first sentence of the next
 * line unless that line is a list item or itself a heading (of the line after it, or of a list), so "## Benefits" / "Visa sponsorship"
 * / "Not available." pairs the last two, and "Visa sponsorship:" / "Not available" / "Benefits" / "- Gym" pairs the first two. A
 * joined line is never a heading itself, so joins do not chain.
 */
export function segmentText(description: string, options: SegmentOptions): TextSegment[] {
  const abbreviations = options.abbreviations ?? [];
  const known = new Set((abbreviations.length > 0 ? abbreviations : DEFAULT_ABBREVIATIONS).map((a) => a.toLowerCase().replace(/\.$/u, "")));
  const lines = linesOf(description);
  // sentence ranges are computed lazily: only for lines that are short enough to be a heading, or that are kept
  const rangeCache = new Map<number, Range[]>();
  const rangesOf = (index: number): Range[] => {
    let ranges = rangeCache.get(index);
    if (ranges === undefined) {
      ranges = sentencesOf(description, lines[index] as Line, known);
      rangeCache.set(index, ranges);
    }
    return ranges;
  };
  // a heading: not a list item, short, and either ending in ":", a "#" heading, or one sentence without end punctuation
  const shaped = (index: number): boolean => {
    const line = lines[index] as Line;
    if (line.listItem || line.end - line.start > options.headingMaxChars) return false;
    if (line.markdownHeading || description.charAt(line.end - 1) === ":") return true;
    return !END_PUNCTUATION.test(description.charAt(line.end - 1)) && rangesOf(index).length === 1;
  };
  // joins[i]: line i is a heading read with line i + 1. Decided from the bottom: a line that is itself a heading (it joins the line
  // after it, or a list follows it) is not read as the content of the heading above, which then stands alone.
  const joins: boolean[] = new Array<boolean>(lines.length).fill(false);
  const heads: boolean[] = new Array<boolean>(lines.length).fill(false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const next = lines[index + 1];
    if (next === undefined || !shaped(index)) continue;
    joins[index] = !next.listItem && !heads[index + 1];
    heads[index] = joins[index] || next.listItem;
  }
  const segments: TextSegment[] = [];
  const emit = (range: Range, listItem: boolean): void => {
    segments.push({ text: description.slice(range.start, range.end), start: range.start, end: range.end, listItem });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    if (joins[index]) {
      const next = lines[index + 1] as Line;
      if (options.keep === undefined || options.keep(line.start, next.end)) {
        const own = rangesOf(index);
        const after = rangesOf(index + 1);
        const heading = own[own.length - 1] as Range;
        for (const range of own.slice(0, -1)) emit(range, false);
        emit({ start: heading.start, end: (after[0] as Range).end }, false);
        for (const range of after.slice(1)) emit(range, next.listItem);
      }
      index += 1;
      continue;
    }
    if (options.keep !== undefined && !options.keep(line.start, line.end)) continue;
    for (const range of rangesOf(index)) emit(range, line.listItem);
  }
  return segments;
}
