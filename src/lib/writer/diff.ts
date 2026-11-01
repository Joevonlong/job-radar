/**
 * A version the user edited by hand: the new text is split into sentences again, and a sentence that is unchanged (after
 * normalising case and whitespace) keeps the check result it had; every other sentence is `user_written`. Client-safe.
 */
import type { CheckedSentence } from "./types";

const SENTENCE_END = /(?<=[.!?…])\s+(?=\S)|(?<=[。！？])\s*(?=\S)/u;

/** The sentences of a text: paragraphs split on blank lines, then sentences on end punctuation. */
export function splitSentences(text: string): { text: string; newParagraph: boolean }[] {
  const out: { text: string; newParagraph: boolean }[] = [];
  for (const [index, paragraph] of text.split(/\n\s*\n/u).entries()) {
    const sentences = paragraph
      .replace(/\s+/gu, " ")
      .trim()
      .split(SENTENCE_END)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== "");
    for (const [position, sentence] of sentences.entries()) out.push({ text: sentence, newParagraph: index > 0 && position === 0 && out.length > 0 });
  }
  return out;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A sentence starts at the start of the text or after end punctuation (and closing quotes or brackets). */
const SENTENCE_START = String.raw`(?<=^|[。！？]\s*|[.!?…]["'”’)\]]*\s+)`;

/** Where `sentence` stands in `text` as a whole sentence, ignoring case and whitespace; null when it does not. */
function locate(text: string, sentence: string): { start: number; end: number } | null {
  const body = sentence.trim();
  if (body === "") return null;
  // a sentence ending in CJK punctuation may be followed directly by the next one
  const end = /[。！？]$/u.test(body) ? "" : String.raw`(?=\s|$)`;
  const match = new RegExp(`${SENTENCE_START}${escape(body).replace(/\s+/gu, String.raw`\s+`)}${end}`, "iu").exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * The sentences of an edited text, with the check results of `previous` kept where a sentence did not change. A kept
 * sentence is found in the text as it was (it may hold an inner full stop, "e.g. " or a quoted sentence); only the text
 * between kept sentences is split again, and that becomes `user_written`.
 */
export function diffSentences(previous: readonly CheckedSentence[], text: string): CheckedSentence[] {
  const out: CheckedSentence[] = [];
  const written = (sentence: string, newParagraph: boolean): CheckedSentence => ({ text: sentence, newParagraph, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] });
  for (const [index, paragraph] of text.split(/\n\s*\n/u).entries()) {
    let rest = paragraph.replace(/\s+/gu, " ").trim();
    const first = out.length;
    const opens = (): boolean => index > 0 && out.length === first && first > 0;
    while (rest !== "") {
      // the earliest unchanged sentence; of two starting at the same place, the longer
      let best: { sentence: CheckedSentence; start: number; end: number } | null = null;
      for (const sentence of previous) {
        const found = locate(rest, sentence.text);
        if (found && (best === null || found.start < best.start || (found.start === best.start && found.end > best.end))) best = { sentence, ...found };
      }
      const before = best === null ? rest : rest.slice(0, best.start);
      for (const piece of splitSentences(before)) out.push(written(piece.text, opens()));
      if (best === null) break;
      out.push({ ...best.sentence, text: rest.slice(best.start, best.end), newParagraph: opens() });
      rest = rest.slice(best.end).trim();
    }
  }
  return out;
}

/** The length of a text in the unit of the question: words (CJK characters count one each) or characters. */
export function textLength(text: string, unit: "words" | "chars"): number {
  if (unit === "chars") return [...text.replace(/\s+/gu, " ").trim()].length;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const words = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length ?? 0;
  return cjk + words;
}
