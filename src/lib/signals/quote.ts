import type { Span } from "./types";

/** Start and end (exclusive, without the newline) of the line containing `index`. */
export function lineBounds(text: string, index: number): Span {
  const start = index <= 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index);
  return { start, end: newline === -1 ? text.length : newline };
}

/** Sentence ranges of a line: a sentence ends at ".", "!" or "?" followed by whitespace or the end ("85.000" does not end one). */
function sentenceRanges(line: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (!".!?".includes(line.charAt(i))) continue;
    let end = i + 1;
    while (end < line.length && ".!?".includes(line.charAt(end))) end += 1;
    if (end === line.length || /\s/u.test(line.charAt(end))) {
      ranges.push({ from, to: end });
      from = end;
    }
    i = end - 1;
  }
  if (from < line.length) ranges.push({ from, to: line.length });
  return ranges;
}
const LEADING_MARKER = /^(?:[-*•–·]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)/u;

/**
 * The sentence of the line that holds `hit`, trimmed, without a list marker; at most `maxChars`
 * long (a longer sentence is cut around the hit at word boundaries). The result is a verbatim
 * substring of `text` (C7); `offset` is where it starts.
 */
export function sentenceAround(text: string, hit: Span, maxChars: number): { quote: string; offset: number } {
  const line = lineBounds(text, hit.start);
  const lineText = text.slice(line.start, line.end);
  let start = line.start;
  let end = line.end;
  for (const range of sentenceRanges(lineText)) {
    const from = line.start + range.from;
    const to = line.start + range.to;
    if (hit.start >= from && hit.start < to) {
      start = from;
      end = Math.max(to, Math.min(hit.end, line.end));
      break;
    }
  }
  return clipQuote(text, start, end, hit, maxChars);
}

/**
 * `text[start, end)` trimmed, without a leading list marker, and at most `maxChars` long (cut around `hit` at word boundaries):
 * a verbatim substring of `text` and where it starts.
 */
export function clipQuote(text: string, start: number, end: number, hit: Span, maxChars: number): { quote: string; offset: number } {
  // trim whitespace and a leading list marker
  while (start < end && /\s/u.test(text.charAt(start))) start += 1;
  while (end > start && /\s/u.test(text.charAt(end - 1))) end -= 1;
  const marker = LEADING_MARKER.exec(text.slice(start, end));
  if (marker && start + marker[0].length <= hit.start) start += marker[0].length;

  if (end - start > maxChars) {
    const hitLength = Math.min(hit.end - hit.start, maxChars);
    const room = Math.max(0, maxChars - hitLength);
    let from = Math.max(start, hit.start - Math.floor(room / 2));
    let to = Math.min(end, from + maxChars);
    from = Math.max(start, to - maxChars);
    // do not cut a word in half (unless that would cut into the hit)
    if (from > start) {
      const nextSpace = text.slice(from, hit.start).search(/\s/u);
      if (nextSpace !== -1 && from + nextSpace < hit.start) from += nextSpace + 1;
    }
    if (to < end) {
      const lastSpace = text.slice(hit.end, to).search(/\s\S*$/u);
      if (lastSpace !== -1 && hit.end + lastSpace > hit.start) to = hit.end + lastSpace;
    }
    start = from;
    end = to;
    while (start < end && /\s/u.test(text.charAt(start))) start += 1;
    while (end > start && /\s/u.test(text.charAt(end - 1))) end -= 1;
  }
  return { quote: text.slice(start, end), offset: start };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `quote` sits in `description`, or null. A quote counts only when it is a substring of the
 * JD (C7). Whitespace differences (a line break the model turned into a space) are tolerated; the
 * returned `quote` is then the JD's own text, so what is stored is always verbatim.
 */
export function locateQuote(description: string, quote: string): { quote: string; offset: number } | null {
  const trimmed = quote.trim();
  if (trimmed === "") return null;
  const exact = description.indexOf(trimmed);
  if (exact !== -1) return { quote: trimmed, offset: exact };
  const tokens = trimmed.split(/\s+/u).filter((t) => t !== "");
  if (tokens.length < 2) return null;
  const flexible = new RegExp(tokens.map(escapeRegex).join("\\s+"), "u").exec(description);
  return flexible ? { quote: flexible[0], offset: flexible.index } : null;
}
