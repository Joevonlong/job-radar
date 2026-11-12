import { z } from "zod";
import { reloadConfig } from "@/lib/config";
import { loadContact } from "@/lib/career/contact/store";
import { checkWithoutPdf, documentExportHints } from "@/lib/career/render/check";
import { previewDocument } from "@/lib/career/render/preview";
import { toResume } from "@/lib/career/render/to-resume";
import { emptyContact } from "@/lib/career/schema/contact";
import { dayInZone } from "@/lib/insights/range";
import { checkCareerDocumentOutput } from "@/lib/mcp/dto/career";
import { defineCapability, READ_ONLY } from "../types";
import { careerAvailability, careerCleaner, careerRead, documentInput, storedDocument } from "./shared";

export const check_career_document = defineCapability({
  id: "check_career_document",
  kind: "read",
  permission: "career:read",
  input: (ctx) => documentInput(ctx).extend({ doc: z.enum(["resume", "letter"]).describe(ctx.text("params.careerDoc")) }),
  output: checkCareerDocumentOutput,
  handler: (ctx, args) => careerRead(ctx, async () => {
    const { contact } = await loadContact();
    const scrub = careerCleaner(ctx, contact);
    const { document } = await storedDocument(args);
    const options = {
      images: {}, doc: args.doc, scrubText: scrub,
      today: dayInZone(ctx.now(), ctx.timezone()), check: reloadConfig("career").check,
    };
    const preview = previewDocument(document, { ...options, contact: emptyContact() });
    const notices = [ctx.text("notice.thirdParty")];
    if (!preview.ok) return {
      notices, renderable: false, issues: preview.issues.map((issue) => ({ path: scrub(issue.path), code: issue.code })),
      text: null, pageBudget: null, findings: [], uncovered: [], exportHints: null,
    };
    const findings = (items: typeof preview.findings) => items.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      ...(finding.path === undefined ? {} : { path: scrub(finding.path) }),
      params: Object.fromEntries(Object.entries(finding.params).filter(([key, value]) =>
        ["count", "max", "min", "months", "total", "years", "pages", "budget"].includes(key) && typeof value === "number")),
    }));
    const { resume } = toResume(document, contact, options.images, args.doc);
    const exportHints = documentExportHints(document, { ...options, contact });
    return {
      notices,
      renderable: true,
      issues: [],
      text: preview.text,
      pageBudget: preview.pageBudget,
      findings: findings(checkWithoutPdf(resume, options)),
      uncovered: preview.uncovered,
      exportHints: { findings: findings(exportHints.findings), uncovered: preview.exportHints.uncovered },
    };
  }),
  count: () => 1,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.check_career_document.title", description: "tools.check_career_document.description" },
});
