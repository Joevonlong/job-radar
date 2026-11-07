import { z } from "zod";
import type { CareerConfig } from "@/lib/config/schemas/career";

export const PDF_CODES = ["pdf_unavailable", "pdf_busy", "pdf_failed", "pdf_too_large"] as const;
export type PdfCode = typeof PDF_CODES[number];
export type PdfResult = { ok: true; pdf: Uint8Array<ArrayBuffer>; pages: number } | { ok: false; code: PdfCode };
const pageCount = z.coerce.number().int().positive().safe();

export async function renderPdf(html: string, settings: CareerConfig["pdf"]): Promise<PdfResult> {
  if (Buffer.byteLength(html, "utf8") > settings.max_html_bytes) return { ok: false, code: "pdf_too_large" };
  let response: Response;
  try {
    response = await fetch(`${settings.url.replace(/\/+$/, "")}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, tagged: true, outline: true }),
      signal: AbortSignal.timeout(settings.timeout_seconds * 1000), redirect: "error", cache: "no-store",
    });
  } catch {
    return { ok: false, code: "pdf_unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const code = response.status === 429 ? "pdf_busy" : response.status === 413 ? "pdf_too_large" : "pdf_failed";
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
