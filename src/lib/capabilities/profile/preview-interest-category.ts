import { z } from "zod";

import { categoryPreviewRequestSchema, previewCategory } from "@/lib/interests/preview";
import { previewInterestCategoryOutput, toCategoryPreviewDto } from "@/lib/mcp/dto";
import { shortFieldCleaner } from "@/lib/mcp/guard";
import { loadJobQuoteGuard, readTraps } from "@/lib/mcp/tools/shared";

import { defineCapability, READ_ONLY } from "../types";

export const preview_interest_category = defineCapability({
  id: "preview_interest_category",
  kind: "read",
  permission: "profile:read",
  input: (ctx) => z.strictObject({
    draft: categoryPreviewRequestSchema.shape.draft.describe(ctx.text("params.interestDraft")),
    categoryId: categoryPreviewRequestSchema.shape.categoryId.describe(ctx.text("params.interestCategoryId")),
  }),
  output: previewInterestCategoryOutput,
  handler: async (ctx, args) => {
    const preview = await previewCategory(args, { db: ctx.db });
    const quote = await loadJobQuoteGuard(ctx, preview.status === "ok" ? preview.samples.map((sample) => sample.jobId) : []);
    return previewInterestCategoryOutput.parse({
      notices: [ctx.text("notice.thirdParty")],
      preview: toCategoryPreviewDto(preview, shortFieldCleaner(readTraps(ctx)), quote),
    });
  },
  count: (output) => output.preview.status === "ok" ? output.preview.samples.length : 0,
  annotations: READ_ONLY,
  text: { title: "tools.preview_interest_category.title", description: "tools.preview_interest_category.description" },
});
