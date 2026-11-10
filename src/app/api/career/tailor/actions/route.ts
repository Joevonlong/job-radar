import { z } from "zod";
import { readCareerGate } from "@/lib/config/career-gate";
import { loadConfig } from "@/lib/config";
import { documentIdSchema } from "@/lib/career/schema/document";
import { acceptProposal, rejectProposal } from "@/lib/career/tailor/apply";
import { removeProposal } from "@/lib/career/tailor/proposals";
import { confirmTranslation, decideClaim } from "@/lib/career/document/claims";
import { saveBackToProfile } from "@/lib/career/document/save-back";
import { persistDocument } from "@/lib/career/store/documents";
import { reply, refuse, failure, jsonBody } from "../reply";
export const dynamic = "force-dynamic";
const base = { doc_id: documentIdSchema, baseHash: z.string().regex(/^[a-f0-9]{64}$/) };
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.enum(["accept", "reject"]), item_id: z.string().regex(/^prp_[a-z2-7]{10}$/) }),
  z.strictObject({ ...base, action: z.literal("confirm_translation") }),
  z.strictObject({ ...base, action: z.literal("claim"), claim_id: z.string().regex(/^clm_[a-z2-7]{10}$/), status: z.enum(["confirmed", "rejected"]) }),
  z.strictObject({ ...base, action: z.literal("save_back"), text_id: z.string().regex(/^dtx_[a-z2-7]{10}$/), target: z.string().max(100).optional() }),
]);
export async function POST(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const settings = loadConfig("career");
    const input = inputSchema.parse(await jsonBody(request, settings.document.max_request_bytes, settings.import.upload_timeout_seconds));
    if (input.action === "reject") {
      await rejectProposal(input.doc_id, input.item_id);
      return reply({ ok: true });
    }
    const result = input.action === "accept" ? await acceptProposal(input.doc_id, input.item_id, input.baseHash)
      : input.action === "save_back" ? await saveBackToProfile(input.doc_id, input.text_id, { baseHash: input.baseHash, target: input.target })
      : await persistDocument(input.doc_id, input.baseHash, (doc) => ({
        ...(input.action === "claim" ? decideClaim(doc, input.claim_id, input.status) : confirmTranslation(doc)), updated_at: new Date().toISOString(),
      }), (saved) => removeProposal(input.doc_id, null, { from: input.baseHash, to: saved }));
    return result.ok ? reply(result) : refuse(result.code);
  } catch (error) { return failure(error); }
}
