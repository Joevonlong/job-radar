import { readCareerGate } from "@/lib/config/career-gate";
import { getDb } from "@/lib/db";
import { documentIdSchema } from "@/lib/career/schema/document";
import { readCareerTailorStatus } from "@/lib/career/tailor/request";
import { reply, refuse, failure } from "../reply";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const id = documentIdSchema.parse(new URL(request.url).searchParams.get("doc_id"));
    return reply(await readCareerTailorStatus(getDb(), id));
  } catch (error) { return failure(error); }
}
