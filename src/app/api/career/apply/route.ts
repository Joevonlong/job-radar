/**
 * Apply the career profile to matching. `preview` reads only; `confirm` writes me.yaml and stories.yaml when nothing changed
 * since the preview it sends the bases of. Responses are never cached.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { applyBasesSchema, applySelectionSchema, confirmApply, previewApply } from "@/lib/career/apply/service";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readBody } from "@/lib/stories/read-body";
import { reply, refuse, storeFailure } from "../extract/reply";

export const dynamic = "force-dynamic";

const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preview"), selection: applySelectionSchema.nullable().default(null) }),
  z.strictObject({ action: z.literal("confirm"), selection: applySelectionSchema, bases: applyBasesSchema }),
]);

const APPLY_STATUS = { me_required: 409, profile_empty: 409, too_many: 409 } as const;

function refuseApply(error: keyof typeof APPLY_STATUS): NextResponse {
  return reply({ ok: false, error }, APPLY_STATUS[error]);
}

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
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid");
    if (parsed.data.action === "preview") {
      const preview = await previewApply(parsed.data.selection);
      return "error" in preview ? refuseApply(preview.error) : reply({ ok: true, preview });
    }
    const result = await confirmApply(parsed.data.selection, parsed.data.bases);
    if (result.status === "error") return refuseApply(result.code);
    return reply({ ok: true, result });
  } catch (error) {
    logActionFailure("careerApplyRoute", error);
    return storeFailure(error);
  }
}
