import { z } from "zod";
import { reloadConfig } from "@/lib/config";
import { previewDocument } from "@/lib/career/render/preview";
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
    const scrub = careerCleaner(ctx);
    const { document } = await storedDocument(args);
    const preview = previewDocument(document, {
      contact: emptyContact(), images: {}, doc: args.doc,
      today: dayInZone(ctx.now(), ctx.timezone()), check: reloadConfig("career").check,
    });
    const notices = [ctx.text("notice.thirdParty")];
    if (!preview.ok) return {
      notices, renderable: false, issues: preview.issues.map((issue) => ({ path: scrub(issue.path), code: issue.code })),
      text: null, pageBudget: null, findings: [], uncovered: [], exportHints: null,
    };
    const findings = (items: typeof preview.findings) => items.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      ...(finding.path === undefined ? {} : { path: scrub(finding.path) }),
      params: Object.fromEntries(Object.entries(finding.params).map(([key, value]) => [
        key, typeof value === "string" ? scrub(value) : value,
      ])),
    }));
    return {
      notices,
      renderable: true,
      issues: [],
      text: scrub(preview.text),
      pageBudget: preview.pageBudget,
      findings: findings(preview.findings),
      uncovered: preview.uncovered,
      exportHints: { findings: findings(preview.exportHints.findings), uncovered: preview.exportHints.uncovered },
    };
  }),
  count: () => 1,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.check_career_document.title", description: "tools.check_career_document.description" },
});
