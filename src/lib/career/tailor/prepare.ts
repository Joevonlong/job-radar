import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { loadConfig } from "@/lib/config";
import { withFileLock } from "@/lib/config/write";
import { descriptionHash } from "@/lib/translation/hash";
import { CareerStoreError } from "../contact/errors";
import { generateDocument } from "../document/generate";
import { documentIdSchema } from "../schema/document";
import { createDocument, listDocuments, loadDocument, saveDocument } from "../store/documents";
import { loadCareerProfile } from "../store/profile";
import { loadPreferences } from "../store/preferences";
import { careerProfilePath } from "../store/paths";
import { loadTailorContext } from "./context";
import { readProposals } from "./proposals";
import { previewOutbound } from "./assemble";

export const tailorPrepareSchema = z.strictObject({
  doc_id: documentIdSchema.optional(), jobId: z.number().int().positive().optional(), mode: z.enum(["tailor", "shrink"]),
  requirements: z.array(z.string()).optional(), with_letter: z.boolean().optional(), new: z.boolean().optional(),
});

export async function prepareTailor(db: Db, raw: unknown) {
  const input = tailorPrepareSchema.parse(raw);
  const settings = loadConfig("career");
  if (input.requirements && (input.requirements.length > settings.tailor.max_requirements || input.requirements.some((text) => text.length > settings.tailor.requirement_max_chars))) throw new CareerStoreError("limits");
  let docId = input.doc_id;
  if (!docId) {
    if (input.mode === "shrink" || !input.jobId) throw new CareerStoreError("job_gone");
    const job = await getJobForBreakdown(db, input.jobId);
    if (!job) throw new CareerStoreError("job_gone");
    if (!job.description?.trim()) throw new CareerStoreError("no_jd");
    const prepared = await withFileLock(careerProfilePath(), async () => {
      if (!input.new) for (const summary of await listDocuments()) {
        if ("invalid" in summary) continue;
        const loaded = await loadDocument(summary.id);
        if (loaded.document.job?.id === job.id) return { existing: true as const, doc_id: summary.id };
      }
      const loaded = await loadCareerProfile();
      const { preferences } = await loadPreferences();
      const doc = generateDocument(loaded.profile, loaded.baseHash, preferences.layout, new Date().toISOString(), `${job.company} – ${job.title}`);
      doc.kind = "tailored";
      doc.job = { id: job.id, company: job.company, title: job.title, jd_hash: descriptionHash(job.description) };
      doc.requirements = input.requirements ?? [];
      await createDocument(doc);
      return { existing: false as const, doc_id: doc.id };
    });
    if (prepared.existing) return prepared;
    docId = prepared.doc_id;
  }
  let loaded = await loadDocument(docId);
  if (input.jobId !== undefined && loaded.document.job?.id !== input.jobId) throw new CareerStoreError("job_gone");
  if (input.requirements !== undefined) {
    const saved = await saveDocument(docId, { ...loaded.document, requirements: input.requirements }, { baseHash: loaded.baseHash });
    if (!saved.ok) throw new CareerStoreError("write_failed");
    loaded = saved;
  }
  const { outbound } = await loadTailorContext(db, { doc_id: docId, jobId: loaded.document.job?.id ?? null, mode: input.mode }, settings);
  return { doc_id: docId, existing: false as const, hasProposals: Boolean((await readProposals(docId))?.items.length), ...previewOutbound(outbound) };
}
