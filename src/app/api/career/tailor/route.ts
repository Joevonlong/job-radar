import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { requestCareerTailor } from "@/lib/career/tailor/request";
import { reply, refuse, failure, jsonBody } from "./reply";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const settings = loadConfig("career");
    const result = await requestCareerTailor(getDb(), await jsonBody(request, settings.document.max_request_bytes, settings.import.upload_timeout_seconds));
    if (result.state === "error") return refuse(result.error, result);
    return reply({ ok: true, ...result });
  } catch (error) { return failure(error); }
}
