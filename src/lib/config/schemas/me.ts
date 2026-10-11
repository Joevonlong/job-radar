import { z } from "zod";

import { nonEmptyString, nonNegativeNumber } from "./common";

export const LANGUAGE_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2", "native"] as const;

/** One entry such as `{ en: C1 }`: ISO 639 language code mapped to a CEFR level (or "native"). */
const languageEntry = z
  .record(z.string().regex(/^[a-z]{2,3}$/, "language code must be 2-3 lowercase letters"), z.enum(LANGUAGE_LEVELS))
  .refine((entry) => Object.keys(entry).length === 1, "each entry must have exactly one language");

const skill = z.strictObject({
  name: nonEmptyString,
  years: nonNegativeNumber.nullable(),
});

/** data/profile/me.yaml — about me. Sent to AI providers as a short summary only. */
export const meSchema = z.strictObject({
  languages: z.array(languageEntry),
  skills: z.array(skill),
  years_experience: nonNegativeNumber.nullable(),
  city: nonEmptyString,
  needs_visa_sponsorship: z.boolean(),
  /** Short text shown to the AI scorer; keep it free of personal identifiers. */
  summary: z.string().max(4000),
});

export type MeConfig = z.infer<typeof meSchema>;
