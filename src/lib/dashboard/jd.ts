/**
 * JD text → display blocks. The JD is external data: it is never turned into HTML, only into a
 * small block model React renders as text. Supported markup is the little the sources produce:
 * `# heading` (any level), `- item` / `* item` / `1. item` list items, blank-line separated
 * paragraphs, and inline `**bold**`, `[text](url)` (shown as its text) and backslash escapes.
 * Real descriptions are Markdown produced from the source HTML.
 */

export interface JdSegment {
  text: string;
  bold?: boolean;
  /** Index into the `quotes` list when this segment is a highlighted signal quote. */
  quote?: number;
}

export type JdBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; segments: JdSegment[] }
  | { type: "list"; items: JdSegment[][] };

const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|<>~])/g;

/** Inline Markdown → plain pieces: links keep their text, escapes are undone, `**x**` / `__x__` become bold pieces. */
export function inlinePieces(line: string): Array<{ text: string; bold: boolean }> {
  const withoutLinks = line.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1").replace(/`([^`]*)`/g, "$1");
  const pieces: Array<{ text: string; bold: boolean }> = [];
  const pattern = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
  let cursor = 0;
  for (const match of withoutLinks.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push({ text: withoutLinks.slice(cursor, start), bold: false });
    pieces.push({ text: match[2] ?? "", bold: true });
    cursor = start + match[0].length;
  }
  if (cursor < withoutLinks.length) pieces.push({ text: withoutLinks.slice(cursor), bold: false });
  // a `**` left over (bold that spans lines, `** x **`, an unbalanced marker) is dropped instead of shown literally; an escaped `\*\*` stays
  return pieces
    .map((p) => ({ ...p, text: (p.bold ? p.text : p.text.replace(/(?<!\\)\*\*/g, "")).replace(ESCAPABLE, "$1") }))
    .filter((p) => p.text !== "");
}

/** Inline pieces of a line with the signal quotes highlighted inside each piece. */
function lineSegments(line: string, quotes: readonly string[]): JdSegment[] {
  const out: JdSegment[] = [];
  for (const piece of inlinePieces(line)) {
    for (const segment of highlightQuotes(piece.text, quotes)) out.push(piece.bold ? { ...segment, bold: true } : segment);
  }
  return out.length > 0 ? out : [{ text: "" }];
}

/** The text of a quote as the JD panel shows it: links, `**bold**`, backticks and backslash escapes resolved. */
export function displayQuote(quote: string): string {
  return inlinePieces(quote).map((p) => p.text).join("");
}

/**
 * Split `line` around the first occurrence of each quote (a quote spanning lines is not highlighted).
 * Quotes are verbatim JD text, which is Markdown: a quote that contains markup is also looked for as
 * it is displayed.
 */
export function highlightQuotes(line: string, quotes: readonly string[]): JdSegment[] {
  const hits: Array<{ start: number; end: number; quote: number }> = [];
  quotes.forEach((quote, index) => {
    for (const needle of new Set([quote.trim(), displayQuote(quote.trim())])) {
      if (needle === "") continue;
      const start = line.indexOf(needle);
      if (start === -1) continue;
      const end = start + needle.length;
      if (hits.some((h) => start < h.end && end > h.start)) return;
      hits.push({ start, end, quote: index });
      return;
    }
  });
  hits.sort((a, b) => a.start - b.start);

  const segments: JdSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ text: line.slice(cursor, hit.start) });
    segments.push({ text: line.slice(hit.start, hit.end), quote: hit.quote });
    cursor = hit.end;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments.length > 0 ? segments : [{ text: line }];
}

export function parseJd(text: string, quotes: readonly string[] = []): JdBlock[] {
  const blocks: JdBlock[] = [];
  let list: JdSegment[][] | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", segments: lineSegments(paragraph.join(" "), quotes) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) blocks.push({ type: "list", items: list });
    list = null;
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: inlinePieces(heading[1] ?? "").map((p) => p.text).join("") });
      continue;
    }
    const bullet = /^(?:[-*•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list = list ?? [];
      list.push(lineSegments(bullet[1] ?? "", quotes));
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * For each quote: whether the JD text shows it highlighted, by the same rule `parseJd` applies (the first occurrence in
 * one line; a quote spanning lines or sharing its text with an earlier quote is not found). The detail page only offers
 * "jump to the original" for a quote that is found.
 */
export function quotesFoundInJd(text: string | null, quotes: readonly string[]): boolean[] {
  const found = quotes.map(() => false);
  if (!text) return found;
  const note = (segments: JdSegment[]): void => {
    for (const segment of segments) if (segment.quote !== undefined) found[segment.quote] = true;
  };
  for (const block of parseJd(text, quotes)) {
    if (block.type === "paragraph") note(block.segments);
    else if (block.type === "list") for (const item of block.items) note(item);
  }
  return found;
}
