import { z } from "zod";

import { ConfigError, reloadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { requestStoryExtract } from "@/lib/control/story-extract-request";
import { getDb } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { STORY_EXTRACT_ORIGINS } from "@/lib/stories/extract";
import { reply, refuse } from "./reply";

export const dynamic = "force-dynamic";
const inputSchema = z.strictObject({ origin: z.enum(STORY_EXTRACT_ORIGINS), text: z.string() });

/**
 * `POST /api/me/story-extract`: start a story extraction from a text confirmed in the preview (`{ origin, text }`). A route
 * rather than a server action, like the prepare route next to it. Host, Origin and login are checked by `src/proxy.ts`, like
 * every other route. The text goes only into the request's payload; it is not logged. With the career profile on, extraction
 * moves to the career page: every request is refused with `use_career` before its body is read.
 */
export async function POST(request: Request) {
  try {
    if ((await readCareerGate()).enabled) return refuse("use_career");
    const writer = reloadConfig("writer");
    if (!writer.enabled) return refuse("disabled");
    if (!request.headers.get("content-type")?.includes("application/json")) return refuse("invalid");
    const body = await readBody(request, writer.import.max_file_bytes, writer.import.upload_timeout_seconds * 1000);
    if (body === null) return refuse("too_large");
    if (body === "timeout") return refuse("invalid");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(body)); }
    catch { return refuse("invalid"); }
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid");
    const outcome = await requestStoryExtract(getDb(), { ...parsed.data, writer });
    if (outcome.state === "error") return refuse(outcome.error, { text: outcome.text, highlights: outcome.highlights });
    return reply({ ok: true, requestId: outcome.requestId, truncated: false });
  } catch (error) {
    if (error instanceof ConfigError) return refuse("config_error");
    logActionFailure("storyExtractRoute", error);
    return refuse("unavailable");
  }
}
