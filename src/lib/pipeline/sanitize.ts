const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Longest code point `String.fromCodePoint` accepts. */
const MAX_CODE_POINT = 0x10ffff;

function codePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CODE_POINT ? String.fromCodePoint(value) : fallback;
}

export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return codePoint(Number.parseInt(entity.slice(2), 16), match);
    if (entity.startsWith("#")) return codePoint(Number.parseInt(entity.slice(1), 10), match);
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** HTML (or text with entities) to plain text; block-level tags become line breaks. */
export function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<\s*(?:\/p|\/h[1-6])\s*>/gi, "\n\n")
    .replace(/<\s*(?:br|\/div|\/tr|\/ul|\/ol)\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "")
    .replace(/[\t  ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A title as one line of plain text. */
export function cleanTitle(value: string): string {
  return stripHtml(value).replace(/\s+/g, " ").trim();
}
