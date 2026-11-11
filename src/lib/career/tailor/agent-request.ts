import type { AgentCaller } from "@/lib/agent-access/caller";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { CareerStoreError } from "../contact/errors";
import { loadDocument } from "../store/documents";
import { loadTailorContext } from "./context";
import { requestCareerTailor } from "./request";

/** The agent entry prepares the current outbound hash inside the career module without returning private document content. */
export async function requestAgentCareerTailor(db: Db, input: { doc_id: string; job_id?: number; with_letter: boolean }, caller: AgentCaller) {
  try {
    const jobId = input.job_id ?? (await loadDocument(input.doc_id)).document.job?.id ?? null;
    const payload = { mode: "tailor" as const, doc_id: input.doc_id, jobId, with_letter: input.with_letter };
    const { outbound } = await loadTailorContext(db, payload, loadConfig("career"));
    const result = await requestCareerTailor(db, { ...payload, outbound_hash: outbound.hash }, { caller });
    return result.state === "error"
      ? { state: "error" as const, error: result.error }
      : { state: "queued" as const, requestId: result.requestId, existing: result.existing };
  } catch (error) {
    if (error instanceof CareerStoreError) return { state: "error" as const, error: error.code };
    throw error;
  }
}
