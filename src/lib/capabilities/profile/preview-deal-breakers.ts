import { z } from "zod";

import { previewDealBreakersOutput, toDealBreakerPreviewDto } from "@/lib/mcp/dto";
import { shortFieldCleaner } from "@/lib/mcp/guard";
import { readTraps } from "@/lib/mcp/tools/shared";
import { previewPersonalDealBreakers, previewRequestSchema } from "@/lib/profile/deal-breaker-preview";

import { defineCapability, READ_ONLY } from "../types";

export const preview_deal_breakers = defineCapability({
  id: "preview_deal_breakers",
  kind: "read",
  permission: "profile:read",
  input: (ctx) => z.strictObject({ rules: previewRequestSchema.describe(ctx.text("params.dealBreakerRules")) }),
  output: previewDealBreakersOutput,
  handler: async (ctx, args) => {
    const preview = await previewPersonalDealBreakers(ctx.db, args.rules);
    return previewDealBreakersOutput.parse({ notices: [ctx.text("notice.thirdParty")], ...toDealBreakerPreviewDto(preview, shortFieldCleaner(readTraps(ctx))) });
  },
  count: (output) => output.rules.length,
  annotations: READ_ONLY,
  text: { title: "tools.preview_deal_breakers.title", description: "tools.preview_deal_breakers.description" },
});
