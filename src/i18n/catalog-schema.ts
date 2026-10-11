/**
 * The shape of the two data-only namespaces every `messages/<id>.json` carries, `meta` and `format`. The catalog
 * generator (`scripts/i18n-catalog.ts`) validates them with these schemas; the generated catalog
 * (`catalog.generated.ts`) holds the validated values. Pure: no I/O, safe in client bundles.
 */
import { z } from "zod";

/** A BCP 47 tag `Intl` accepts (`en-US`, `zh-CN`, `fr`). */
export const intlTagSchema = z.string().refine((value) => {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}, "not a BCP 47 language tag");

export const localeMetaSchema = z.strictObject({
  /** The language's own name for itself (`English`, `中文`, `Français`): the language menu shows it. */
  name: z.string().trim().min(1),
  /** The tag passed to `Intl` and written into `lang` attributes (`en-US`, `zh-CN`). */
  intl: intlTagSchema,
  /** How a prompt names the language to an AI model (`English`, `Simplified Chinese`). */
  promptName: z.string().trim().min(1),
  /** Wide characters (CJK): a word is short in characters but wide on screen, so length limits count differently. */
  wide: z.boolean(),
});
export type LocaleMeta = z.infer<typeof localeMetaSchema>;

const text = z.string().min(1);

export const formatLabelsSchema = z.strictObject({
  /** Relative time of lists; `{n}` is the formatted number. */
  relative: z.strictObject({ now: text, minutes: text, hours: text, yesterday: text }),
  /** Unit words of a duration (`3 h 20 min`). */
  duration: z.strictObject({ d: text, h: text, m: text, s: text, lessThanMinute: text }),
  /** Appended after a salary figure when the period is shown (`/yr`). */
  salaryPeriod: z.strictObject({ year: text, month: text, week: text, day: text, hour: text }),
  /** `up to €120k`, `€90k and up`. */
  salary: z.strictObject({ upTo: text, from: text }),
  /** Joins the labels of a multi-select summary. */
  listSeparator: text,
  /** Month style of a short date: `2-digit` gives `10/05`, `short` gives `Oct 5` (with the `Intl` tag of `meta.intl`). */
  shortDateMonth: z.enum(["2-digit", "short"]),
});
export type FormatLabels = z.infer<typeof formatLabelsSchema>;

/** The languages whose messages files must be complete: every other one falls back to `en` for missing keys. */
export const CORE_LOCALES = ["en", "zh"] as const;
/** The language a missing key falls back to, and the one used when nothing else is known. */
export const FALLBACK_LOCALE = "en";

/** A messages file name (without `.json`) that can be a locale id: a lowercase language subtag, optionally a region. */
export const LOCALE_ID_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
