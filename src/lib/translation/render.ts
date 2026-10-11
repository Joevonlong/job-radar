import { parseJd } from "@/lib/dashboard/jd";
import type { SignalTier } from "@/lib/db/queries/types";
import type { SignalColor } from "@/lib/signals/palette";

import { STORED_MARKER_PATTERN } from "./markers";

/**
 * Stored translation → display blocks. The translation is model output about external data, so like
 * the JD it is never turned into HTML: the Markdown the prompt asks for (headings, lists, `**bold**`)
 * becomes blocks React renders as text, and `[[<category id>]]…[[/<category id>]]` markers become highlighted segments
 * (only of the active categories; a marker of a deleted or unknown category is dropped, its text stays plain).
 */
export interface TranslationSegment {
  text: string;
  bold?: boolean;
  /** Set when the segment is the translation of a sentence that carries a signal of an active category. */
  tier?: SignalTier;
  /** That category's colour. */
  color?: SignalColor;
}

export type TranslationBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; segments: TranslationSegment[] }
  | { type: "list"; items: TranslationSegment[][] };

const marker = (): RegExp => new RegExp(STORED_MARKER_PATTERN, "g");

/** The categories whose markers are highlighted, with their colours. */
export type MarkerCategories = ReadonlyArray<{ id: string; color: SignalColor }>;

/** Split the segments of one paragraph / list item at its markers (a marker may sit between two bold pieces). */
function applyMarkers(segments: Array<{ text: string; bold?: boolean }>, colors: ReadonlyMap<string, SignalColor>): TranslationSegment[] {
  const out: TranslationSegment[] = [];
  let open: SignalTier | null = null;
  for (const segment of segments) {
    let cursor = 0;
    const push = (text: string): void => {
      if (text === "") return;
      const color = open === null ? undefined : colors.get(open);
      out.push({ text, ...(segment.bold ? { bold: true } : {}), ...(open !== null && color ? { tier: open, color } : {}) });
    };
    for (const match of segment.text.matchAll(marker())) {
      const at = match.index ?? 0;
      push(segment.text.slice(cursor, at));
      cursor = at + match[0].length;
      open = match[1] === "/" ? null : (match[2] ?? null);
    }
    push(segment.text.slice(cursor));
  }
  return out;
}

export function parseTranslation(content: string, categories: MarkerCategories = []): TranslationBlock[] {
  const colors = new Map(categories.map((category) => [category.id, category.color]));
  return parseJd(content).map((block): TranslationBlock => {
    if (block.type === "heading") return { type: "heading", text: block.text.replace(marker(), "") };
    if (block.type === "list") return { type: "list", items: block.items.map((item) => applyMarkers(item, colors)) };
    return { type: "paragraph", segments: applyMarkers(block.segments, colors) };
  });
}
