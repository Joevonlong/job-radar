/**
 * Shortening of a long JD quote on the detail page: the collapsed view shows a window of at most `maxChars`
 * characters that keeps the term which makes the quote a signal (the amount, "equity", ...) in sight; the rest is
 * behind "expand". Pure; the quote itself is never changed (C7), only how much of it shows.
 */

export interface QuoteWindow {
  /** Text offsets, `end` exclusive. */
  start: number;
  end: number;
  /** Something is cut off before / after the window (the view shows an ellipsis there). */
  cutStart: boolean;
  cutEnd: boolean;
}

export interface QuoteTerm {
  start: number;
  end: number;
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);

/** Move `index` forward to the start of the next word (never past `limit`). */
function wordStartAfter(text: string, index: number, limit: number): number {
  let i = index;
  while (i < limit && !isSpace(text[i])) i += 1;
  while (i < limit && isSpace(text[i])) i += 1;
  return i >= limit ? index : i;
}

/** Move `index` back to the end of a word (never before `floor`). */
function wordEndBefore(text: string, index: number, floor: number): number {
  let i = index;
  while (i > floor && !isSpace(text[i])) i -= 1;
  while (i > floor && isSpace(text[i - 1])) i -= 1;
  return i <= floor ? index : i;
}

/** Whether `text` is short enough to show whole. */
export function fitsWhole(text: string, maxChars: number): boolean {
  return text.length <= maxChars;
}

/**
 * The part of a quote to show while it is collapsed: `lead` characters before the term (so it reads as part of a
 * sentence), then up to `maxChars` in all, cut at word boundaries. Without a term the window starts at the beginning.
 * A term longer than the window gets the room it needs.
 */
export function quoteWindow(text: string, term: QuoteTerm | null, maxChars: number, lead: number): QuoteWindow {
  if (fitsWhole(text, maxChars)) return { start: 0, end: text.length, cutStart: false, cutEnd: false };
  let start = 0;
  if (term !== null && term.start > lead) {
    const wanted = term.start - lead;
    start = wordStartAfter(text, wanted, term.start);
    // a word boundary was not found before the term: cut where the lead says
    if (start === wanted && wanted > 0 && !isSpace(text[wanted - 1]) && !isSpace(text[wanted])) start = wanted;
  }
  let end = Math.min(text.length, start + maxChars);
  if (term !== null) end = Math.max(end, Math.min(text.length, term.end));
  if (end < text.length) end = wordEndBefore(text, end, term === null ? start : Math.max(start, term.end));
  return { start, end, cutStart: start > 0, cutEnd: end < text.length };
}
