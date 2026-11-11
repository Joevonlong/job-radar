import { z } from "zod";
import { buildCareerProfileSchema, CAREER_FILE_BOUNDS, profileContent, refineCareerProfile, type CareerProfile } from "../schema/profile";
import { redactStructure } from "./redact-structure";
import { careerOutboundScrubber } from "./scrub";

export const redactedProfileSchema = z.strictObject(buildCareerProfileSchema(
  z.string().max(CAREER_FILE_BOUNDS.textChars).nullable().default(null),
).shape).omit({ adopted_entries: true }).superRefine(refineCareerProfile);

export function redactProfile(profile: CareerProfile, scrub = careerOutboundScrubber()) {
  return redactedProfileSchema.parse(redactStructure(profileContent(profile), scrub));
}
