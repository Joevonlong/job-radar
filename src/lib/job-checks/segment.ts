/**
 * Cuts a JD into the pieces the job checks judge one by one: sentences, list items, and a short heading line ending in ":" together
 * with the line after it ("Visa sponsorship:" / "Not available"). Every piece is a verbatim range of the text (C7).
 */

/** A piece of the text: `text === description.slice(start, end)`. */
export interface TextSegment {
  text: string;
  start: number;
  end: number;
}

/** Abbreviations whose dot does not end a sentence, used when the caller passes none (lower case, without the final dot). */
export const DEFAULT_ABBREVIATIONS: readonly string[] = ["e.g", "i.e", "etc", "incl", "approx", "vs", "z.b", "ca", "inkl", "bzw", "usw", "u.a", "d.h", "ggf"];

/** Longest heading line (trimmed, with its ":") that is joined with the next line. */
export const HEADING_MAX_CHARS = 60;

const LIST_MARKER = /^(?:[-*•–·]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)/u;
const SPACE = /\s/u;
const LOWER_START = /^\p{Ll}/u;

interface Line {
  /** Where the line's content starts (after leading spaces and a list marker) and ends (before trailing spaces). */
  start: number;
  end: number;
  /** The line starts with a list marker. */
  listItem: boolean;
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
    const marker = LIST_MARKER.exec(text.slice(start, end));
    if (marker) {
      start += marker[0].length;
      while (start < end && SPACE.test(text.charAt(start))) start += 1;
    }
    if (end > start) lines.push({ start, end, listItem: marker !== null });
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

/** Cuts `description` into segments (in text order, not overlapping). */
export function segmentText(description: string, abbreviations: readonly string[] = DEFAULT_ABBREVIATIONS): TextSegment[] {
  const known = new Set((abbreviations.length > 0 ? abbreviations : DEFAULT_ABBREVIATIONS).map((a) => a.toLowerCase().replace(/\.$/u, "")));
  const lines = linesOf(description);
  const segments: TextSegment[] = [];
  let carry: { start: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    const ranges = sentencesOf(description, line, known);
    if (carry !== null && ranges.length > 0) {
      const first = ranges[0] as { start: number; end: number };
      ranges[0] = { start: carry.start, end: first.end };
      carry = null;
    }
    const next = lines[index + 1];
    const heading = description.charAt(line.end - 1) === ":" && line.end - line.start <= HEADING_MAX_CHARS && next !== undefined && !next.listItem;
    if (heading) {
      // the heading (the line's last sentence) waits for the first sentence of the next line
      const last = ranges.pop() as { start: number; end: number };
      carry = { start: last.start };
    }
    for (const range of ranges) segments.push({ text: description.slice(range.start, range.end), start: range.start, end: range.end });
  }
  return segments;
}
