import { z } from "zod";

import { ConfigError, reloadConfig } from "@/lib/config";
import { profileSourceText } from "@/lib/control/story-extract-request";
import { logActionFailure } from "@/lib/logging/action-failure";
import { NO_STORED_VALUES } from "@/lib/outbound/outbound";
import { readPrepareInput } from "@/lib/outbound/prepare";
import { prepareScrub } from "@/lib/outbound/scrub";
import { readBody } from "@/lib/stories/read-body";
import { neutralizeStorySource } from "@/lib/stories/source";
import { enterUpload } from "@/lib/stories/upload-gate";
import { reply, refuse } from "../reply";

export const dynamic = "force-dynamic";
const profileInput = z.strictObject({ origin: z.literal("profile") });

export async function POST(request: Request) {
  let release: (() => void) | null = null;
  try {
    const writer = reloadConfig("writer");
    if (!writer.enabled) return refuse("disabled");
    const limits = writer.import;
    let source = request;
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await readBody(request, limits.max_file_bytes, limits.upload_timeout_seconds * 1000);
      if (body === null) return refuse("too_large");
      if (body === "timeout") return refuse("invalid");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(body)); }
      catch { return refuse("invalid"); }
      const profile = profileInput.safeParse(raw);
      const input = profile.success ? { text: profileSourceText(reloadConfig("me")) } : raw;
      source = new Request(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: request.signal });
    } else {
      release = enterUpload(limits.max_concurrent_uploads);
      if (release === null) return refuse("too_many");
    }
    const result = await readPrepareInput(source, limits);
    if (!result.ok) return refuse(result.error);
    if (result.input.text.trim().length < limits.min_chars) return refuse("no_text");
    return reply({ ok: true, ...prepareScrub(neutralizeStorySource(result.input.text), { ...result.input, stored: NO_STORED_VALUES, rules: limits }) });
  } catch (error) {
    if (error instanceof ConfigError) return refuse("config_error");
    logActionFailure("prepareStoryExtract", error);
    return refuse("unavailable");
  } finally { release?.(); }
}
