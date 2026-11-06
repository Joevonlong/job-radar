/**
 * The text of an uploaded résumé, in memory only: nothing here writes a file, not even to the temp directory, and the file's
 * name is not kept. Server only.
 */
import { Worker } from "node:worker_threads";
import { z } from "zod";

import { STORY_IMPORT_FORMATS, type StoryImportFormat } from "@/lib/config/schemas/writer";

export type UploadTextError = "bad_type" | "unreadable" | "no_text" | "too_complex" | "aborted";
type UploadTextSuccess = { ok: true; text: string; pagesNotRead?: boolean };
export type UploadTextResult = UploadTextSuccess | { ok: false; error: UploadTextError };
const pdfReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string(), pagesNotRead: z.boolean() }),
  z.object({ ok: z.literal(false) }),
]);

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

export interface UploadTextLimits {
  maxChars: number;
  minChars: number;
  /** `import.pdf_timeout_seconds`, in milliseconds. */
  pdfTimeoutMs: number;
  /** `import.pdf_max_memory_mb`: the heap limit of the reading thread (off-heap memory is not counted; the time limit is the real guard). */
  pdfMaxMemoryMb: number;
  /** Aborted when the client goes away: reading stops. */
  signal?: AbortSignal;
}

/**
 * The PDF's text layer, read in a worker thread that is killed at the time limit, at the heap limit or when the client
 * goes away. It gets a copy of the bytes (they move to the thread), no environment and the file's text nowhere but in the
 * message back. No OCR: a scanned page has no text.
 */
function pdfText(bytes: Uint8Array, limits: UploadTextLimits): Promise<UploadTextResult> {
  return new Promise((resolve) => {
    if (limits.signal?.aborted) {
      resolve({ ok: false, error: "aborted" });
      return;
    }
    const copy = bytes.slice();
    const worker = new Worker(new URL("./pdf-text.worker.mjs", import.meta.url), {
      workerData: { bytes: copy, maxChars: limits.maxChars },
      transferList: [copy.buffer as ArrayBuffer],
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: limits.pdfMaxMemoryMb },
    });
    let settled = false;
    const finish = (result: UploadTextResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().then(
        () => resolve(result),
        () => resolve(result),
      );
    };
    const onAbort = (): void => finish({ ok: false, error: "aborted" });
    const timer = setTimeout(() => finish({ ok: false, error: "too_complex" }), limits.pdfTimeoutMs);
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (raw: unknown) => {
      const message = pdfReplySchema.safeParse(raw);
      finish(message.success && message.data.ok
        ? { ok: true, text: foldCjkRadicals(message.data.text), pagesNotRead: message.data.pagesNotRead }
        : { ok: false, error: "unreadable" });
    });
    worker.once("error", (error: NodeJS.ErrnoException) => finish({ ok: false, error: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_complex" : "unreadable" }));
    worker.once("exit", () => finish({ ok: false, error: "unreadable" }));
  });
}

/** Read the text of a file of `format`; `maxChars`: `import.max_chars` (the caller cuts it exactly). */
export async function textOfUpload(bytes: Uint8Array, format: StoryImportFormat, limits: UploadTextLimits): Promise<UploadTextResult> {
  let text: string;
  let pagesNotRead = false;
  if (format === "pdf") {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: false, error: "bad_type" };
    const read = await pdfText(bytes, limits);
    if (!read.ok) return read;
    text = read.text;
    pagesNotRead = read.pagesNotRead ?? false;
  } else {
    const decoded = decodeText(bytes);
    if (decoded === null) return { ok: false, error: "bad_type" };
    text = decoded;
  }
  const trimmed = text.trim();
  return trimmed.length < limits.minChars
    ? { ok: false, error: "no_text" }
    : { ok: true, text: trimmed, ...(pagesNotRead ? { pagesNotRead } : {}) };
}
