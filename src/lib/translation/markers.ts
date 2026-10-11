import type { SignalTier } from "@/lib/db/queries/types";

/**
 * Signal highlights inside a translation (spec: best effort). The model wraps the translation of a
 * marked sentence in `[[S<n>]]…[[/S<n>]]`; before the text is stored `S<n>` becomes the sentence's
 * category id (`[[T1]]…[[/T1]]`: any category id), so the stored content stays valid when the signal list
 * changes later.
 */
const SOURCE_MARKER = /\[\[(\/?)S(\d{1,3})\]\]/g;
/** A stored marker: an optional `/` and a category id (the format of `SIGNAL_CATEGORY_ID`). */
export const STORED_MARKER_PATTERN = "\\[\\[(\\/?)([A-Za-z][A-Za-z0-9_-]{0,23})\\]\\]";
const STORED_MARKER = new RegExp(STORED_MARKER_PATTERN, "g");

export interface MarkableSignal {
  tier: SignalTier;
  quote: string;
}

export interface MarkedSentence {
  tier: SignalTier;
  text: string;
}

/** Longest quote that is worth asking the model to find again, and how many to ask for per piece. */
const MAX_QUOTE_CHARS = 300;
const MAX_MARKED_PER_PIECE = 12;

/** The signal quotes that occur verbatim in `chunk` (C7: quotes are JD text), in order of appearance. */
export function markedSentencesFor(chunk: string, signals: readonly MarkableSignal[]): MarkedSentence[] {
  const seen = new Set<string>();
  const hits: Array<MarkedSentence & { at: number }> = [];
  for (const signal of signals) {
    const text = signal.quote.trim();
    if (text === "" || text.length > MAX_QUOTE_CHARS || seen.has(text)) continue;
    const at = chunk.indexOf(text);
    if (at === -1) continue;
    seen.add(text);
    hits.push({ tier: signal.tier, text, at });
  }
  return hits
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_MARKED_PER_PIECE)
    .map(({ tier, text }) => ({ tier, text }));
}

/**
 * Model output → stored form. Markers become tier markers; markers the prompt did not define, pairs
 * that are not opened and closed on the same line, and nested pairs are dropped (the text stays).
 */
export function normalizeMarkers(translation: string, marked: readonly MarkedSentence[]): string {
  const withTiers = translation.replace(SOURCE_MARKER, (_all, slash: string, n: string) => {
    const sentence = marked[Number(n) - 1];
    return sentence ? `[[${slash}${sentence.tier}]]` : "";
  });
  return withTiers
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(balanceLine)
    .join("\n");
}

function balanceLine(line: string): string {
  const tokens: Array<{ at: number; end: number; close: boolean; tier: string }> = [];
  for (const match of line.matchAll(STORED_MARKER)) {
    const at = match.index ?? 0;
    tokens.push({ at, end: at + match[0].length, close: match[1] === "/", tier: match[2] ?? "" });
  }
  if (tokens.length === 0) return line;

  // Decide which tokens survive: an open that is not nested and has its close later on the line.
  const keep = new Set<number>();
  let open: { index: number; tier: string } | null = null;
  let nested = 0;
  tokens.forEach((token, index) => {
    if (!token.close) {
      if (open) nested += 1;
      else open = { index, tier: token.tier };
    } else if (nested > 0) {
      nested -= 1;
    } else if (open && open.tier === token.tier) {
      keep.add(open.index);
      keep.add(index);
      open = null;
    }
  });

  let out = "";
  let cursor = 0;
  tokens.forEach((token, index) => {
    out += line.slice(cursor, token.at);
    if (keep.has(index)) out += line.slice(token.at, token.end);
    cursor = token.end;
  });
  return out + line.slice(cursor);
}

/** Stored translation without its markers (plain text, e.g. for copying or length checks). */
export function stripMarkers(content: string): string {
  return content.replace(STORED_MARKER, "");
}
