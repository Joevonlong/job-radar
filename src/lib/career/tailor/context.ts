import type { Db } from "@/lib/db/client";
import { getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { cleanDescriptionForAi } from "@/lib/traps/clean";
import type { CareerConfig } from "@/lib/config/schemas/career";
import type { CareerTailorPayload } from "@/lib/control/types";
import { CareerStoreError } from "../contact/errors";
import { loadDocument } from "../store/documents";
import { loadCareerProfile } from "../store/profile";
import { loadPreferences } from "../store/preferences";
import { assembleOutbound } from "./assemble";

export async function loadTailorContext(db: Db, payload: Pick<CareerTailorPayload, "doc_id" | "jobId" | "mode">, settings: CareerConfig) {
  let loaded;
  try { loaded = await loadDocument(payload.doc_id); }
  catch (error) {
    if (error instanceof CareerStoreError && error.code === "document_missing") throw new CareerStoreError("doc_gone");
    throw error;
  }
  const { profile } = await loadCareerProfile();
  const { preferences } = await loadPreferences();
  const jobId = loaded.document.job?.id ?? null;
  if (payload.jobId !== jobId) throw new CareerStoreError("job_gone");
  const job = jobId === null ? null : await getJobForBreakdown(db, jobId);
  if (jobId !== null && !job) throw new CareerStoreError("job_gone");
  if (payload.mode === "tailor" && !job?.description?.trim()) throw new CareerStoreError("no_jd");
  const cleaned = job ? { ...job, description: await cleanDescriptionForAi(db, { jobId: job.id, description: job.description }) } : null;
  const outbound = assembleOutbound({ doc: loaded.document, profile, preferences, job: cleaned, mode: payload.mode, settings });
  return { ...loaded, profile, outbound };
}
