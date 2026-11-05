import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { requestCareerExtract } from "@/lib/career/extract/request";
import { getDb } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { reply, refuse, storeFailure } from "./reply";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const settings = loadConfig("career");
    const body = await readBody(request, settings.import.max_file_bytes, settings.import.upload_timeout_seconds * 1000);
    if (body === null) return refuse("too_large");
    if (body === "timeout") return refuse("invalid");
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(body)); }
    catch { return refuse("invalid"); }
    const outcome = await requestCareerExtract(getDb(), raw);
    if (outcome.state === "error") return refuse(outcome.error, outcome.text === undefined ? {} : { text: outcome.text });
    return reply({ ok: true, requestId: outcome.requestId, existing: outcome.existing });
  } catch (error) {
    logActionFailure("careerExtractRoute", error);
    return storeFailure(error);
  }
}
