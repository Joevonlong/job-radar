import { z } from "zod";
import type { CareerConfig } from "@/lib/config/schemas/career";

export const PDF_CODES = ["pdf_unavailable", "pdf_busy", "pdf_failed", "pdf_too_large"] as const;
export type PdfCode = typeof PDF_CODES[number];
export type PdfResult = { ok: true; pdf: Uint8Array<ArrayBuffer>; pages: number } | { ok: false; code: PdfCode };
const pageCount = z.coerce.number().int().positive().safe();

/**
 * The PDF service prints one document at a time and answers 429 while it is busy, for example while the editor's
 * page count is printing. A busy answer is retried every `busy_retry_ms` until `timeout_seconds` has passed in total,
 * so an export clicked during a page count waits its turn instead of failing. `signal` stops the wait early when the
 * caller no longer needs the result.
 */
export async function renderPdf(html: string, settings: CareerConfig["pdf"], signal?: AbortSignal): Promise<PdfResult> {
  if (Buffer.byteLength(html, "utf8") > settings.max_html_bytes) return { ok: false, code: "pdf_too_large" };
  const deadline = AbortSignal.timeout(settings.timeout_seconds * 1000);
  const stop = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const body = JSON.stringify({ html, tagged: true, outline: true });
  let response: Response;
  for (;;) {
    try {
      response = await fetch(`${settings.url.replace(/\/+$/, "")}/render`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: stop, redirect: "error", cache: "no-store",
      });
    } catch {
      return { ok: false, code: "pdf_unavailable" };
    }
    if (response.status !== 429) break;
    await response.body?.cancel().catch(() => undefined);
    if (!(await pause(settings.busy_retry_ms, stop))) return { ok: false, code: "pdf_busy" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const code = response.status === 413 ? "pdf_too_large" : "pdf_failed";
    return { ok: false, code };
  }
  const pages = pageCount.safeParse(response.headers.get("X-Page-Count"));
  if (!pages.success || response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/pdf") {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, code: "pdf_failed" };
  }
  try {
    const pdf = new Uint8Array(await response.arrayBuffer());
    if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") return { ok: false, code: "pdf_failed" };
    return { ok: true, pdf, pages: pages.data };
  } catch {
    return { ok: false, code: "pdf_failed" };
  }
}

function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (waited: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
      resolve(waited);
    };
    const stopped = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", stopped, { once: true });
  });
}
