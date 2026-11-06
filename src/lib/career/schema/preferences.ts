import { z } from "zod";

import { careerLayoutDefaultsSchema } from "@/lib/config/schemas/career";
import { CAREER_FILE_BOUNDS } from "./profile";

const text = z.string().max(CAREER_FILE_BOUNDS.textChars).nullable();
export const preferencesSchema = z.strictObject({
  schema_version: z.literal(1),
  layout: careerLayoutDefaultsSchema,
  emphasis: text,
  tone: text,
});
export type CareerPreferences = z.infer<typeof preferencesSchema>;
