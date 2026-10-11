/**
 * A job description is translated in pieces: one reply has to fit the providers' output limit
 * (`max_output_tokens`), and Chinese output of a 10 000-character JD does not. Pieces end at
 * paragraph boundaries wherever possible, so the Markdown structure survives the concatenation.
 */
export const TRANSLATION_CHUNK_CHARS = 3500;

/** Split `text` into pieces of at most `maxChars`, preferring blank lines, then line breaks, then spaces. */
export function splitIntoChunks(text: string, maxChars: number = TRANSLATION_CHUNK_CHARS): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized === "") return [];
  if (normalized.length <= maxChars) return [normalized];

  // Paragraphs, then oversized paragraphs cut at line breaks / spaces.
  const pieces: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    if (paragraph.length <= maxChars) pieces.push(paragraph);
    else pieces.push(...cutLong(paragraph, maxChars));
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current === "") current = piece;
    else if (current.length + 2 + piece.length <= maxChars) current += `\n\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function cutLong(paragraph: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = window.lastIndexOf("\n");
    if (cut < maxChars / 2) cut = window.lastIndexOf(" ");
    if (cut < maxChars / 2) cut = maxChars;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") out.push(rest);
  return out;
}

/** Re-join translated chunks. Chunk boundaries were paragraph boundaries (or cut points inside one paragraph). */
export function joinChunks(translated: readonly string[]): string {
  return translated.map((t) => t.trim()).filter((t) => t !== "").join("\n\n");
}
