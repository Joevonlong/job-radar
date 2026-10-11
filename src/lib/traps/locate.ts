/**
 * Find a text taken from the source HTML in the JD text the converters made from it. The two differ in whitespace, line
 * breaks and list markers ("\n- " for `<li>`), never in the words: compare without whitespace and bullets, then map back.
 */

/** A list bullet the converters write at the start of a line ("- ", "* ", "• "). */
const BULLET = /[-*•]/u;

interface Squeezed {
  text: string;
  /** Offset in the original text of every character of `text`. */
  map: number[];
}

/** `text` without whitespace and without line-start bullets, with the original offset of every character kept. */
function squeeze(text: string, dropBullets: boolean): Squeezed {
  const out: string[] = [];
  const map: number[] = [];
  let lineStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (/\s/u.test(ch)) {
      if (ch === "\n") lineStart = true;
      continue;
    }
    if (dropBullets && lineStart && BULLET.test(ch) && /\s/u.test(text.charAt(i + 1))) {
      lineStart = false;
      continue;
    }
    lineStart = false;
    out.push(ch);
    map.push(i);
  }
  return { text: out.join(""), map };
}

/**
 * Where `needle` sits in `haystack` when whitespace, line breaks and list bullets are ignored; `end` is exclusive and both are
 * offsets in `haystack`, so `haystack.slice(start, end)` is the JD's own text. Null when not found (or `needle` has no text).
 */
export function locateLoose(haystack: string, needle: string): { start: number; end: number } | null {
  const trimmed = needle.trim();
  if (trimmed === "") return null;
  const exact = haystack.indexOf(trimmed);
  if (exact !== -1) return { start: exact, end: exact + trimmed.length };
  const hay = squeeze(haystack, true);
  for (const dropBullets of [false, true]) {
    const pin = squeeze(trimmed, dropBullets).text;
    if (pin === "") continue;
    const at = hay.text.indexOf(pin);
    if (at === -1) continue;
    const start = hay.map[at];
    const last = hay.map[at + pin.length - 1];
    if (start === undefined || last === undefined) continue;
    return { start, end: last + 1 };
  }
  return null;
}
