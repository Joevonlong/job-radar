import { readCareerGate } from "@/lib/config/career-gate";
import { documentIdSchema } from "@/lib/career/schema/document";
import { loadDocument } from "@/lib/career/store/documents";
import { readProposals } from "@/lib/career/tailor/proposals";
import { reply, refuse, failure } from "../reply";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!(await readCareerGate()).enabled) return refuse("disabled");
  try {
    const id = documentIdSchema.parse(new URL(request.url).searchParams.get("doc_id"));
    const loaded = await loadDocument(id);
    const proposals = await readProposals(id);
    return reply({ ok: true, proposals, document_changed: proposals !== null && proposals.doc_hash !== loaded.baseHash });
  } catch (error) { return failure(error); }
}
