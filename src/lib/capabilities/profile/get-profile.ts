import { z } from "zod";

import { ToolFailure } from "@/lib/mcp/context";
import { getProfileOutput, toMeDto, toPreferencesDto, toStoriesDto, type GetProfileOutput } from "@/lib/mcp/dto";
import { loadProfilePage } from "@/lib/profile/view";

import { defineCapability, READ_ONLY } from "../types";

export const get_profile = defineCapability({
  id: "get_profile",
  kind: "read",
  permission: "profile:read",
  input: (ctx) => z.strictObject({ parts: z.array(z.enum(["me", "preferences", "stories"])).min(1).max(3).optional().describe(ctx.text("params.profileParts")) }),
  output: getProfileOutput,
  handler: async (ctx, args) => {
    const parts = args.parts ?? ["me", "preferences", "stories"];
    const page = await loadProfilePage({ parts });
    for (const part of parts) {
      if (!page[part]?.draft || !page[part]?.hash) throw new ToolFailure("unavailable", ctx.text("errors.personalUnavailable"));
    }
    const output: GetProfileOutput = { notices: [] };
    if (page.me?.draft) output.me = { baseHash: page.me.hash, data: toMeDto(page.me.draft) };
    if (page.preferences?.draft) output.preferences = { baseHash: page.preferences.hash, data: toPreferencesDto(page.preferences.draft) };
    if (page.stories?.draft) output.stories = { baseHash: page.stories.hash, data: toStoriesDto(page.stories.draft) };
    return getProfileOutput.parse(output);
  },
  count: (output) => Number(output.me !== undefined) + Number(output.preferences !== undefined) + Number(output.stories !== undefined),
  annotations: READ_ONLY,
  text: { title: "tools.get_profile.title", description: "tools.get_profile.description" },
});
