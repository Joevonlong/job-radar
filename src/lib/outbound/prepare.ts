import { z } from "zod";

import type { CareerConfig } from "@/lib/config/schemas/career";
import { readBody } from "@/lib/stories/read-body";
import { formatOfName, textOfUpload } from "@/lib/stories/upload-text";

const inputSchema = z.strictObject({ text: z.string(), name: z.string().max(20000).optional(), address: z.string().max(20000).optional(), mode: z.literal("values").optional() });
export type PrepareInput = z.infer<typeof inputSchema>;
export type PrepareLimits = Pick<CareerConfig["import"], "formats" | "max_file_bytes" | "upload_timeout_seconds" | "max_chars" | "min_chars" | "pdf_timeout_seconds" | "pdf_max_memory_mb">;
const FORM_OVERHEAD_BYTES = 16 * 1024;
export type PrepareError = "invalid" | "too_large" | "bad_type" | "unreadable" | "too_complex" | "no_text";

/** Uploaded files stay in memory; the preview is the only place that truncates their extracted text. */
export async function readPrepareInput(request: Request, limits: PrepareLimits): Promise<{ ok: true; input: PrepareInput } | { ok: false; error: PrepareError }> {
  const body = await readBody(request, limits.max_file_bytes + FORM_OVERHEAD_BYTES, limits.upload_timeout_seconds * 1000);
  if (body === null) return { ok: false, error: "too_large" };
  if (body === "timeout") return { ok: false, error: "invalid" };
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const parsed = inputSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
      return parsed.success ? { ok: true, input: parsed.data } : { ok: false, error: "invalid" };
    } catch { return { ok: false, error: "invalid" }; }
  }
  let form: FormData;
  try { form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData(); }
  catch { return { ok: false, error: "invalid" }; }
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "invalid" };
  if (file.size > limits.max_file_bytes) return { ok: false, error: "too_large" };
  const format = formatOfName(file.name);
  if (format === null || !limits.formats.includes(format)) return { ok: false, error: "bad_type" };
  const result = await textOfUpload(new Uint8Array(await file.arrayBuffer()), format, {
    maxChars: limits.max_chars + 1, minChars: limits.min_chars, pdfTimeoutMs: limits.pdf_timeout_seconds * 1000,
    pdfMaxMemoryMb: limits.pdf_max_memory_mb, signal: request.signal,
  });
  if (!result.ok) return { ok: false, error: result.error === "aborted" ? "invalid" : result.error };
  return { ok: true, input: { text: result.text } };
}
