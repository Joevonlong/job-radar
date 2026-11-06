import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { prepareTailor } from "@/lib/career/tailor/prepare";
import { reply, refuse, failure, jsonBody } from "../reply";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const settings = loadConfig("career");
    return reply({ ok: true, ...await prepareTailor(getDb(), await jsonBody(request, settings.document.max_request_bytes, settings.import.upload_timeout_seconds)) });
  } catch (error) { return failure(error); }
}
