import { z } from "zod";
import { redactProfile } from "@/lib/career/contact/redact-profile";
import { listVersions, readVersion, versionIdSchema } from "@/lib/career/store/history";
import { imagePresence } from "@/lib/career/store/images";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { getCareerProfileOutput } from "@/lib/mcp/dto/career";
import { defineCapability, READ_ONLY } from "../types";
import { careerAvailability, careerCleaner, careerRead } from "./shared";

export const get_career_profile = defineCapability({
  id: "get_career_profile",
  kind: "read",
  permission: "career:read",
  input: (ctx) => z.strictObject({ version: versionIdSchema.optional().describe(ctx.text("params.careerVersion")) }),
  output: getCareerProfileOutput,
  handler: (ctx, args) => careerRead(ctx, async () => {
    const scrub = careerCleaner(ctx);
    const versions = await listVersions();
    const loaded = args.version
      ? { profile: await readVersion(args.version), baseHash: null, updatedAt: versions.find((v) => v.id === args.version)?.createdAt ?? null }
      : await loadCareerProfile();
    return {
      notices: [],
      profile: redactProfile(loaded.profile, scrub),
      baseHash: loaded.baseHash,
      updatedAt: loaded.updatedAt,
      versions,
      version: args.version ?? null,
      ...await imagePresence(),
    };
  }),
  count: () => 1,
  annotations: READ_ONLY,
  availability: careerAvailability,
  text: { title: "tools.get_career_profile.title", description: "tools.get_career_profile.description" },
});
