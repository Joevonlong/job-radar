/**
 * The text of an uploaded résumé, in memory only: nothing here writes a file, not even to the temp directory, and the file's
 * name is not kept. Server only.
 */
import { getDocumentProxy } from "unpdf";

import { STORY_IMPORT_FORMATS, type StoryImportFormat } from "@/lib/config/schemas/writer";

export type UploadTextError = "bad_type" | "unreadable" | "no_text";
export type UploadTextResult = { ok: true; text: string } | { ok: false; error: UploadTextError };

/** The format a file name claims, or null. The content is checked as well: a name alone proves nothing. */
export function formatOfName(name: string): StoryImportFormat | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const alias = extension === "markdown" ? "md" : extension;
  return STORY_IMPORT_FORMATS.find((format) => format === alias) ?? null;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean => prefix.every((byte, index) => bytes[index] === byte);

/** UTF-8 or (with a byte order mark) UTF-16; anything else is not a text file. */
function decodeText(bytes: Uint8Array): string | null {
  try {
    const utf16 = startsWith(bytes, [0xff, 0xfe]) ? "utf-16le" : startsWith(bytes, [0xfe, 0xff]) ? "utf-16be" : null;
    const text = new TextDecoder(utf16 ?? "utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/**
 * Some PDF producers map CJK characters to their look-alike radicals (U+2F8F for 行). Left in, a quote in ordinary characters
 * would not be found in the text. Only these are folded: the rest of the text stays as it is, so that quotes keep matching it.
 */
export function foldCjkRadicals(text: string): string {
  return text.replace(/[\u2E80-\u2FDF]/gu, (char) => char.normalize("NFKC"));
}

/** The PDF's text layer up to `maxChars` (pages past that are not read). A scanned page has none: no OCR. */
async function pdfText(bytes: Uint8Array, maxChars: number): Promise<string> {
  const pdf = await getDocumentProxy(bytes, { useSystemFonts: false, verbosity: 0 });
  try {
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages && length <= maxChars; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("")
        .replace(/[ \t]+\n/gu, "\n");
      page.cleanup();
      pages.push(text);
      length += text.length;
    }
    return foldCjkRadicals(pages.join("\n\n"));
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Read the text of a file of `format`; `maxChars`: `import.max_chars` (the caller cuts it exactly). */
export async function textOfUpload(bytes: Uint8Array, format: StoryImportFormat, limits: { maxChars: number; minChars: number }): Promise<UploadTextResult> {
  let text: string;
  if (format === "pdf") {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: false, error: "bad_type" };
    try {
      // pdf.js may take over the buffer it is given: it gets a copy
      text = await pdfText(bytes.slice(), limits.maxChars);
    } catch {
      // corrupt, or protected by a password; the reason from pdf.js is not shown (it may quote the file)
      return { ok: false, error: "unreadable" };
    }
  } else {
    const decoded = decodeText(bytes);
    if (decoded === null) return { ok: false, error: "bad_type" };
    text = decoded;
  }
  const trimmed = text.trim();
  return trimmed.length < limits.minChars ? { ok: false, error: "no_text" } : { ok: true, text: trimmed };
}
