import { z } from "zod";
import { listDocuments } from "@/lib/career/store/documents";
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
    const documents = (await listDocuments()).map((summary) => {
      if ("invalid" in summary) return {
        id: summary.id, status: "invalid" as const, title: null, kind: null, updatedAt: null, lang: null, jobId: null,
      };
      return {
        id: summary.id,
        status: "ok" as const,
        title: scrub(summary.title),
        kind: summary.kind,
        updatedAt: summary.updatedAt,
        lang: summary.lang,
        jobId: summary.jobId,
      };
    });
    return { notices: [ctx.text("notice.thirdParty")], documents, total: documents.length };
  }),
  count: (output) => output.documents.length,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.list_career_documents.title", description: "tools.list_career_documents.description" },
});
