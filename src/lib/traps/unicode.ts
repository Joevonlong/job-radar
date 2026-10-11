/**
 * Invisible characters: Unicode tag characters that spell out hidden ASCII, zero-width characters strung inside words,
 * and bidirectional controls that make the shown text differ from the stored one. Pure.
 */
import type { TrapsConfig } from "@/lib/config/schemas/traps";

import type { RawFinding } from "./types";

const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069]+/gu;
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]/u;
/** Characters of context kept on each side of an invisible character in its quote. */
const CONTEXT_CHARS = 20;

/** The ASCII text a run of tag characters spells (U+E0020-E007E → " "-"~"; the others drop out). */
export function decodeTagChars(run: string): string {
  let out = "";
  for (const ch of run) {
    const code = (ch.codePointAt(0) ?? 0) - 0xe0000;
    if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
  }
  return out;
}

/** Whether the zero-width character at `index` is part of an emoji sequence (a joiner between pictographs, a variation). */
function isEmojiJoiner(text: string, index: number): boolean {
  if (text.charAt(index) !== "\u200D") return false;
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + 1, index + 3);
  return PICTOGRAPHIC.test(before) && PICTOGRAPHIC.test(after);
}

/** A window of `text` around [from, to): up to CONTEXT_CHARS on each side, inside the line, never cutting a surrogate pair. */
function windowAround(text: string, from: number, to: number): { quote: string; offset: number } {
  let start = Math.max(0, from - CONTEXT_CHARS);
  let end = Math.min(text.length, to + CONTEXT_CHARS);
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = text.indexOf("\n", to);
  start = Math.max(start, lineStart);
  end = Math.min(end, lineEnd === -1 ? text.length : lineEnd);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end += 1;
  return { quote: text.slice(start, end), offset: start };
}

/** Invisible-character findings of a text (the JD itself). `offset` is set: these are always found in the text that was scanned. */
export function scanInvisibleUnicode(text: string, settings: TrapsConfig, path: string): RawFinding[] {
  const options = settings.invisible_unicode;
  const out: RawFinding[] = [];

  if (options.tag_chars) {
    for (const match of text.matchAll(TAG_RUN)) {
      const decoded = decodeTagChars(match[0]);
      out.push({
        technique: "invisible_unicode",
        method: "tag_chars",
        severity: "trap",
        text: match[0],
        path,
        offset: match.index ?? 0,
        evidence: null,
        instructionId: null,
        detail: { decoded, count: [...match[0]].length },
      });
    }
  }

  if (options.zero_width) {
    // words: runs of non-whitespace; a word with at least `zero_width_min_run` zero-width characters (emoji joiners excluded)
    for (const word of text.matchAll(/\S+/gu)) {
      const base = word.index ?? 0;
      const positions: number[] = [];
      for (let i = 0; i < word[0].length; i += 1) {
        const at = base + i;
        if (ZERO_WIDTH.test(text.charAt(at)) && !isEmojiJoiner(text, at) && !(at === 0 && text.charAt(0) === "\uFEFF")) positions.push(at);
      }
      if (positions.length < options.zero_width_min_run) continue;
      const first = positions[0] as number;
      const last = positions[positions.length - 1] as number;
      const window = windowAround(text, first, last + 1);
      out.push({ technique: "invisible_unicode", method: "zero_width", severity: "suspicious", text: window.quote, path, offset: window.offset, evidence: null, instructionId: null, detail: { count: positions.length } });
    }
  }

  if (options.bidi_controls) {
    for (const match of text.matchAll(BIDI)) {
      const at = match.index ?? 0;
      const window = windowAround(text, at, at + match[0].length);
      // several controls close together make one finding
      if (out.some((f) => f.method === "bidi_controls" && f.offset !== null && window.offset < f.offset + f.text.length && window.offset + window.quote.length > f.offset)) continue;
      out.push({ technique: "invisible_unicode", method: "bidi_controls", severity: "suspicious", text: window.quote, path, offset: window.offset, evidence: null, instructionId: null, detail: { count: match[0].length } });
    }
  }
  return out;
}

/** The characters `jdForAi` deletes from an `invisible` span (zero-width and bidi controls; emoji joiners stay). */
export function stripInvisible(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if ((ZERO_WIDTH.test(ch) && !isEmojiJoiner(text, i)) || /[\u202A-\u202E\u2066-\u2069]/u.test(ch)) continue;
    out += ch;
  }
  return out;
}
