import { z } from "zod";

import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { countSuggestions, listSuggestions } from "@/lib/db/repos/interest-suggestions";
import { loadInterestsPage } from "@/lib/interests/view";
import { ToolFailure } from "@/lib/mcp/context";
import { getInterestsOutput, toInterestSettingsDto, toSuggestionDto } from "@/lib/mcp/dto";
import { shortFieldCleaner } from "@/lib/mcp/guard";
import { readTraps, resultLimit, truncationNotice } from "@/lib/mcp/tools/shared";

import { defineCapability, READ_ONLY } from "../types";

export const get_interests = defineCapability({
  id: "get_interests",
  kind: "read",
  permission: "profile:read",
  input: (ctx) => z.strictObject({ limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.pendingLimit")) }),
  output: getInterestsOutput,
  handler: async (ctx, args) => {
    const page = await loadInterestsPage({ personalOnly: true });
    if (page.loadError || !page.vocabulary) throw new ToolFailure("unavailable", ctx.text("errors.personalUnavailable"));
    const limit = resultLimit(ctx, args.limit);
    const [rows, total] = await Promise.all([listSuggestions(ctx.db, { status: "pending", limit }), countSuggestions(ctx.db, "pending")]);
    const clean = shortFieldCleaner(readTraps(ctx));
    const pending = rows.map((row) => toSuggestionDto(row, clean));
    const truncated = total > pending.length;
    return getInterestsOutput.parse({
      notices: [ctx.text("notice.thirdParty"), ...(truncated ? [truncationNotice(ctx, pending.length, total, limit)] : [])],
      ...toInterestSettingsDto(page), pending_suggestions: pending, total, returned: pending.length, truncated,
    });
  },
  count: (output) => output.vocabulary.categories.length + output.vocabulary.retired.length + output.views.length + output.watched_companies.length + output.returned,
  annotations: READ_ONLY,
  text: { title: "tools.get_interests.title", description: "tools.get_interests.description" },
});
