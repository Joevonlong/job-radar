import { NextResponse } from "next/server";

import { ConfigError, reloadConfig, type WriterConfig } from "@/lib/config";
import { profileSourceText, requestStoryExtract } from "@/lib/control/story-extract-request";
import { getDb } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { enterUpload } from "@/lib/stories/upload-gate";
import { formatOfName, textOfUpload } from "@/lib/stories/upload-text";
import { STORY_EXTRACT_ORIGINS, type StoryExtractOrigin } from "@/lib/stories/extract";
import type { StoryExtractResponse } from "@/lib/stories/extract-response";

export const dynamic = "force-dynamic";

/** What a multipart form adds around the file: its boundary and field names. */
const FORM_OVERHEAD_BYTES = 16 * 1024;

const STATUS = { invalid: 400, too_large: 413, bad_type: 415, unreadable: 422, too_complex: 422, no_text: 422, disabled: 409, busy: 409, too_many: 429, config_error: 500, unavailable: 503 } as const;
type RouteError = keyof typeof STATUS;

function reply(body: StoryExtractResponse, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const refuse = (error: RouteError): NextResponse => reply({ ok: false, error }, STATUS[error]);

const isOrigin = (value: unknown): value is StoryExtractOrigin => STORY_EXTRACT_ORIGINS.some((origin) => origin === value);

/**
 * `POST /api/me/story-extract`: start a story extraction from your profile (`origin=profile`), a pasted text
 * (`origin=self_description`, `text`) or a résumé (`origin=resume`, `file`). A route rather than a server action, whose
 * body limit is smaller than a résumé. Host, Origin and login are checked by `src/proxy.ts`, like every other route. The file
 * stays in memory and only its text goes on, into the request's payload; no file is written, and neither its name nor its
 * text is logged.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let writer: WriterConfig;
  try {
    writer = reloadConfig("writer");
  } catch (error) {
    if (error instanceof ConfigError) return refuse("config_error");
    throw error;
  }
  if (!writer.enabled) return refuse("disabled");

  return handle(request, writer);
}

async function handle(request: Request, writer: WriterConfig): Promise<NextResponse> {
  const limits = writer.import;
  const body = await readBody(request, limits.max_file_bytes + FORM_OVERHEAD_BYTES, limits.upload_timeout_seconds * 1000);
  if (body === "timeout") return refuse("invalid");
  if (body === null) return refuse("too_large");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return refuse("invalid");
  }
  const origin = form.get("origin");
  if (!isOrigin(origin)) return refuse("invalid");

  let text: string;
  if (origin === "profile") {
    try {
      text = profileSourceText(reloadConfig("me"));
    } catch (error) {
      if (error instanceof ConfigError) return refuse("config_error");
      throw error;
    }
  } else if (origin === "self_description") {
    const pasted = form.get("text");
    if (typeof pasted !== "string") return refuse("invalid");
    text = pasted;
  } else {
    const file = form.get("file");
    if (!(file instanceof File)) return refuse("invalid");
    if (file.size > limits.max_file_bytes) return refuse("too_large");
    const format = formatOfName(file.name);
    if (format === null || !limits.formats.includes(format)) return refuse("bad_type");
    // only a file is read by this process side by side with others (its bytes and a PDF thread); pasted text and the profile are not
    const release = enterUpload(limits.max_concurrent_uploads);
    if (release === null) return refuse("too_many");
    let extracted: Awaited<ReturnType<typeof textOfUpload>>;
    try {
      extracted = await textOfUpload(new Uint8Array(await file.arrayBuffer()), format, {
        maxChars: limits.max_chars,
        minChars: limits.min_chars,
        pdfTimeoutMs: limits.pdf_timeout_seconds * 1000,
        pdfMaxMemoryMb: limits.pdf_max_memory_mb,
        signal: request.signal,
      });
    } finally {
      release();
    }
    // the client is gone: nobody reads this answer
    if (!extracted.ok) return refuse(extracted.error === "aborted" ? "invalid" : extracted.error);
    text = extracted.text;
  }

  try {
    const outcome = await requestStoryExtract(getDb(), { origin, text, writer });
    if (outcome.state === "error") return refuse(outcome.error);
    return reply({ ok: true, requestId: outcome.requestId, truncated: outcome.truncated });
  } catch (error) {
    logActionFailure("storyExtractRoute", error);
    return refuse("unavailable");
  }
}
