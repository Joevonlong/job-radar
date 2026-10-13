/**
 * The ends of a heading line, as the ghost check reads them: emoji after it, a final "…", " -" or "—", "..." and "?". Each is a
 * backward scan over the line's last characters, linear in its length. (Unanchored suffix expressions such as `[\s…]+(:?)\s*$`
 * retry every start in a long run of spaces inside a line, which takes seconds: a description may keep such a run, e.g. of
 * U+2003, or get one when emphasis marks are dropped.) Each function returns what the expression in its comment returned.
 */

const SPACE = /^\s$/u;
/** One emoji, symbol, emoji selector, joiner or keycap, or a space. */
const DECORATION = /^[\p{Extended_Pictographic}\p{So}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\s]$/u;
const QUESTION_MARK = /^[?？]$/u;

/** Where the code point that ends at `end` starts. */
function codePointBefore(text: string, end: number): number {
  const low = text.charCodeAt(end - 1);
  if (end >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return end - 2;
  }
  return end - 1;
}

/** Where the run of code points matching `char` that ends at `end` starts (`end` when there is none). */
function runStart(text: string, end: number, char: RegExp): number {
  let at = end;
  while (at > 0) {
    const from = codePointBefore(text, at);
    if (!char.test(text.slice(from, at))) break;
    at = from;
  }
  return at;
}

/** Emoji and spaces after a heading go, a final ":" stays ("Your impact 🌍" → "Your impact", "Outcomes 🎯:" → "Outcomes:"). Was `replace(/[\p{Extended_Pictographic}\p{So}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\s]+(:?)\s*$/u, "$1")`. */
export function stripTrailingDecoration(text: string): string {
  const end = runStart(text, text.length, SPACE);
  if (end > 0 && text[end - 1] === ":") {
    const colon = end - 1;
    const from = runStart(text, colon, DECORATION);
    return from < colon ? `${text.slice(0, from)}:` : text.slice(0, end);
  }
  return text.slice(0, runStart(text, text.length, DECORATION));
}

/** A final "…", " -", " –" or "—" (spaces around it) becomes ":". Was `replace(/\s*(?:…|\s[-–]|—)\s*$/u, ":")`. */
export function trailingPauseAsColon(text: string): string {
  const end = runStart(text, text.length, SPACE);
  const last = text[end - 1];
  const pause = last === "…" || last === "—" || ((last === "-" || last === "–") && end >= 2 && SPACE.test(text[end - 2] as string));
  return pause ? `${text.slice(0, runStart(text, end - 1, SPACE))}:` : text;
}

/** A final "..." (spaces around it) becomes ":". Was `replace(/\s*\.{3}\s*$/u, ":")`. */
export function trailingDotsAsColon(text: string): string {
  const end = runStart(text, text.length, SPACE);
  return end >= 3 && text.slice(end - 3, end) === "..." ? `${text.slice(0, runStart(text, end - 3, SPACE))}:` : text;
}

/** The text ends in "?" or "？" (spaces after it allowed). Was `/\s*[?？]+\s*$/u.test(text)`. */
export function endsInQuestion(text: string): boolean {
  const end = runStart(text, text.length, SPACE);
  return end > 0 && QUESTION_MARK.test(text[end - 1] as string);
}

/** Final question marks (spaces around them) become ":". Was `replace(/\s*[?？]+\s*$/u, ":")`. */
export function questionEndAsColon(text: string): string {
  if (!endsInQuestion(text)) return text;
  const end = runStart(text, text.length, SPACE);
  return `${text.slice(0, runStart(text, runStart(text, end, QUESTION_MARK), SPACE))}:`;
}
