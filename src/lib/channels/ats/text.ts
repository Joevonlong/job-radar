/** HTML → plain text for ATS descriptions (ported from legacy `sanitize.ts`, without the length cap). */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    try {
      if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    } catch {
      return match; // code point out of range
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export interface HtmlToTextOptions {
  /**
   * The markup itself is entity-escaped (`&lt;p&gt;`), as in Greenhouse's `content`: it is unescaped
   * first, and its own entities are decoded afterwards (they arrive double-escaped: `&amp;nbsp;`).
   */
  escaped?: boolean;
}

/** Plain text of an HTML fragment: block ends become line breaks, list items "- " bullets, tags and entities go. */
export function htmlToText(value: string, options: HtmlToTextOptions = {}): string {
  const html = options.escaped ? decodeHtml(value) : value;
  return decodeHtml(
    html
      .replace(/\s*<\s*li\b[^>]*>/gi, "\n- ")
      .replace(/<\s*(br|\/p|\/div|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<\s*\/(ul|ol)\s*>/gi, "\n\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
