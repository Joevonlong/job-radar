import { z } from "zod";

import { SIGNAL_COLORS } from "@/lib/signals/palette";

import { nonEmptyString, nonNegativeNumber, regexString } from "./common";
import { MAX_CATEGORY_ICON_CHARS, SIGNAL_CATEGORY_ID } from "./interests";

const graphemes = (text: string): number => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

/** A list per language (ISO 639-1 code -> entries): the add dialog takes English and the market's local language. */
const perLanguage = <T extends z.ZodType>(item: T) => z.record(z.string().regex(/^[a-z]{2}$/, "must be a two-letter language code"), z.array(item).max(100)).default({});

const preset = z.strictObject({
  /** The id the new category gets (made unique when it is taken); the format of a category id. */
  id: z.string().regex(SIGNAL_CATEGORY_ID, "must start with a letter and contain only letters, digits, _ or - (at most 24)"),
  label: z
    .strictObject({ en: nonEmptyString.max(40).optional(), zh: nonEmptyString.max(40).optional() })
    .refine((label) => label.en !== undefined || label.zh !== undefined, "needs a name in at least one language"),
  icon: nonEmptyString.refine((icon) => graphemes(icon) <= MAX_CATEGORY_ICON_CHARS, `must be at most ${MAX_CATEGORY_ICON_CHARS} characters`).optional(),
  color: z.enum(SIGNAL_COLORS),
  /** Suggested points (the user can change them before saving). */
  weight: nonNegativeNumber.default(0),
  high_value: z.boolean().default(false),
  ai_confirm_only: z.boolean().default(false),
  /** English; what the AI looks for in every reviewed JD (what counts and what does not). */
  ai_definition: nonEmptyString.max(1000),
  keywords: perLanguage(nonEmptyString.max(200)),
  patterns: perLanguage(regexString),
  exclude: perLanguage(regexString),
});
export type SignalPreset = z.infer<typeof preset>;

/**
 * config/signal-presets.yaml (shipped): starting points for the "add a category" dialog on /interests. A preset
 * is only a filled-in form: choosing one copies it into the draft, and the saved category lives in interests.yaml like
 * any other (deleting this file changes nothing that was saved).
 */
export const signalPresetsSchema = z.strictObject({
  presets: z
    .array(preset)
    .max(20)
    .refine((items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length, "preset ids must not contain duplicates"),
});
export type SignalPresetsConfig = z.infer<typeof signalPresetsSchema>;
