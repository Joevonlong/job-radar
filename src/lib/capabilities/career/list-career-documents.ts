import { z } from "zod";
import { listDocuments, loadDocument } from "@/lib/career/store/documents";
import { listCareerDocumentsOutput } from "@/lib/mcp/dto/career";
import { defineCapability, READ_ONLY } from "../types";
import { careerAvailability, careerCleaner, careerRead } from "./shared";

export const list_career_documents = defineCapability({
  id: "list_career_documents",
  kind: "read",
  permission: "career:read",
  input: () => z.strictObject({}),
  output: listCareerDocumentsOutput,
  handler: (ctx) => careerRead(ctx, async () => {
    const scrub = careerCleaner(ctx);
    const documents = await Promise.all((await listDocuments()).map(async (summary) => {
      const invalid = {
        id: summary.id, status: "invalid" as const, title: null, kind: null, updatedAt: null, lang: null, jobId: null,
      };
      if ("invalid" in summary) return invalid;
      try {
        const { document } = await loadDocument(summary.id);
        return {
          id: document.id,
          status: "ok" as const,
          title: scrub(document.title),
          kind: document.kind,
          updatedAt: document.updated_at,
          lang: document.layout.lang,
          jobId: document.job?.id ?? null,
        };
      } catch { return invalid; }
    }));
    return { notices: [ctx.text("notice.thirdParty")], documents, total: documents.length };
  }),
  count: (output) => output.documents.length,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.list_career_documents.title", description: "tools.list_career_documents.description" },
});
