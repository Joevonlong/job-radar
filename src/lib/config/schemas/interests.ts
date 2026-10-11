import { z } from "zod";

import { MAX_FILTER_VALUES, MIN_SALARY_MAX, MIN_SCORE_MAX, TRAP_FILTERS } from "@/lib/jobs/constants";
import { MULTI_VALUE_SCHEMAS } from "@/lib/jobs/filter-values";
import { SIGNAL_COLORS } from "@/lib/signals/palette";

import { nonEmptyString, nonNegativeInt, nonNegativeNumber, positiveInt, stringList } from "./common";

/** Flags used when pattern strings are compiled. */
export const SIGNAL_REGEX_FLAGS = "iu";

const regexString = nonEmptyString.refine((source) => {
  try {
    new RegExp(source, SIGNAL_REGEX_FLAGS);
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

/**
 * user-defined signal categories (interests.yaml v2, `signals.categories`). The list order is the display and
 * sort order. Three kinds:
 * - `amount`: concrete salary figures, parsed and converted (at most one such category);
 * - `keyword`: literal `keywords` (matched case-insensitively on word boundaries) and `patterns` (regular expressions for
 *   inflected or composite phrases); a hit is ignored when an `exclude` match starts shortly before it or inside it
 *   ("diversity, equity and inclusion" is not equity);
 * - `tag`: benefit-like tags, one per tag name (literal `tags`, or `tag_patterns` with a name), never reviewed by the AI.
 * A deleted category moves to `retired_categories` with its whole definition: its stored signals stay in the database
 * but are not shown, scored, filtered or pushed, and it can be restored. Ids are never reused.
 */
export const SIGNAL_CATEGORY_KINDS = ["amount", "keyword", "tag"] as const;
export type SignalCategoryKind = (typeof SIGNAL_CATEGORY_KINDS)[number];
/** Same format as the `signals_tier_format` CHECK of the database. */
export const SIGNAL_CATEGORY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
/** Ids that would collide with other highlight kinds of the detail page (job breakdown quotes, AI traps). Compared case-insensitively. */
export const RESERVED_CATEGORY_IDS = ["breakdown", "trap"] as const;
/** Structural cap of the active categories (and of the retired ones), like `MAX_FILTER_VALUES`. */
export const MAX_SIGNAL_CATEGORIES = 12;
/** Longest icon, in characters as people count them (an emoji is one). */
export const MAX_CATEGORY_ICON_CHARS = 2;
/** `signals.kind` of a keyword signal: short snake_case. */
export const SIGNAL_KIND_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const graphemes = (text: string): number => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

const categoryId = z.string().regex(SIGNAL_CATEGORY_ID, "must start with a letter and contain only letters, digits, _ or - (at most 24)");
const categoryLabel = z
  .strictObject({ zh: nonEmptyString.max(40).optional(), en: nonEmptyString.max(40).optional() })
  .refine((label) => label.zh !== undefined || label.en !== undefined, "needs a name in at least one language");
const categoryIcon = nonEmptyString.refine((icon) => graphemes(icon) <= MAX_CATEGORY_ICON_CHARS, `must be at most ${MAX_CATEGORY_ICON_CHARS} characters`);
const aiDefinition = nonEmptyString.max(1000);

/** Fields every category has after `id` and `kind`, in the order the file shows them. */
const categoryBase = {
  label: categoryLabel,
  /** Shown before the name (Telegram, a tag whose id is longer than 4 characters). */
  icon: categoryIcon.optional(),
  /** One of the palette colours (src/lib/signals/palette.ts). */
  color: z.enum(SIGNAL_COLORS),
  /** Points added to the match score when a job has a signal of this category (each category counts once). */
  weight: nonNegativeNumber.default(0),
  /** A signal of this category makes a job "high value": the quick filter, the lower push threshold, the statistics. */
  high_value: z.boolean().default(false),
};

const amountSettings = z.strictObject({
  /**
   * Amounts below this much per year in the market's base currency (after converting the stated period) are noise ("€50",
   * "€2,000 yearly") and dropped (was `min_annual_eur`).
   */
  min_annual: nonNegativeNumber.default(20000),
  /**
   * Currency used for an amount that names none ("up to 120k") when a salary word is in the same sentence: an ISO code, or
   * `market` = the market's base currency (the default); null drops such amounts.
   */
  assume_currency: z
    .union([z.literal("market"), z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code or market")])
    .nullable()
    .default("market"),
  /**
   * When a stated amount counts (bonus points, high-value signal, coloured badge): `salary_floor` = its annual upper bound
   * is at least `salary_floor_year` of preferences.yaml; a number = at least that much per year in the base currency; `none` = every
   * stated amount counts. Below it the amount is still extracted and shown, muted, without bonus.
   */
  bonus_requires_at_least: z.union([z.literal("salary_floor"), z.literal("none"), nonNegativeNumber]).default("salary_floor"),
  /**
   * Rough rates (base-currency units per unit of the currency), used ONLY for the comparison above when the amount is not
   * in the base currency and pipeline.yaml `salary.fx_rates` gives no figure. A currency in neither table cannot be compared
   * and counts (was `rough_fx_to_eur`).
   */
  rough_fx: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).default({}),
  /**
   * Points of the category when all its amounts are "possibly another region's pay" (pipeline.yaml `salary.local_currencies` /
   * `salary.other_region_patterns`), instead of `weight`. 0 = no bonus, and such an amount is not a high-value signal.
   */
  other_region_weight: nonNegativeNumber.default(0),
});

const amountCategory = z.strictObject({
  id: categoryId,
  kind: z.literal("amount"),
  ...categoryBase,
  /** Candidates only count after the AI confirmed them (absent = off). */
  ai_confirm_only: z.boolean().optional(),
  /** What the AI is told the category means (English). */
  ai_definition: aiDefinition,
  /** Regular expressions of an amount, compiled with flags "iu". */
  patterns: z.array(regexString).min(1),
  /** A hit is ignored when one of these starts within `limits.exclude_lookbehind_chars` before it or inside it ("bonus of €25,000"). */
  exclude: z.array(regexString).default([]),
  amount: amountSettings.default({ min_annual: 20000, assume_currency: "market", bonus_requires_at_least: "salary_floor", rough_fx: {}, other_region_weight: 0 }),
});

const keywordCategory = z.strictObject({
  id: categoryId,
  kind: z.literal("keyword"),
  ...categoryBase,
  /** Broad words ("bonus") only count after the AI confirmed them; with this on, the rule stage does not store them as signals (absent = off). */
  ai_confirm_only: z.boolean().optional(),
  ai_definition: aiDefinition,
  keywords: stringList.default([]),
  patterns: z.array(regexString).default([]),
  exclude: z.array(regexString).default([]),
  /** `signals.kind` of a rule hit (default: the id in lower case). */
  default_kind: z.string().regex(SIGNAL_KIND_PATTERN, "must be snake_case").optional(),
});

const tagCategory = z.strictObject({
  id: categoryId,
  kind: z.literal("tag"),
  ...categoryBase,
  /** Tags are never sent to the AI, so they cannot wait for its confirmation. */
  ai_confirm_only: z.literal(false, { error: "is not available for tag categories" }).optional(),
  /** Only used by the weekly suggestions (which words fit this category). */
  ai_definition: aiDefinition.optional(),
  /** Literal tag names. */
  tags: stringList.default([]),
  /** Tags that need a pattern ("28+ vacation days"): the tag `name` is shown when the pattern matches. */
  tag_patterns: z.array(z.strictObject({ name: nonEmptyString, pattern: regexString })).default([]),
});

export const signalCategorySchema = z.discriminatedUnion("kind", [amountCategory, keywordCategory, tagCategory]);
export type SignalCategory = z.infer<typeof signalCategorySchema>;
export type AmountCategory = z.infer<typeof amountCategory>;
export type KeywordCategory = z.infer<typeof keywordCategory>;
export type TagCategory = z.infer<typeof tagCategory>;
export type AmountSettings = z.infer<typeof amountSettings>;

const signalsSchema = z
  .strictObject({
    categories: z.array(signalCategorySchema).max(MAX_SIGNAL_CATEGORIES),
    /** Deleted categories, kept whole so they can be restored. */
    retired_categories: z.array(signalCategorySchema).max(MAX_SIGNAL_CATEGORIES).default([]),
  })
  .superRefine((signals, ctx) => {
    const seen = new Set<string>();
    const lists = [
      ["categories", signals.categories],
      ["retired_categories", signals.retired_categories],
    ] as const;
    for (const [list, categories] of lists) {
      categories.forEach((category, index) => {
        const key = category.id.toLowerCase();
        if ((RESERVED_CATEGORY_IDS as readonly string[]).includes(key)) ctx.addIssue({ code: "custom", path: [list, index, "id"], message: "is a reserved id" });
        else if (seen.has(key)) ctx.addIssue({ code: "custom", path: [list, index, "id"], message: "must not contain duplicates" });
        seen.add(key);
      });
    }
    const amounts = signals.categories.flatMap((category, index) => (category.kind === "amount" ? [index] : []));
    for (const index of amounts.slice(1)) ctx.addIssue({ code: "custom", path: ["categories", index, "kind"], message: "only one amount category is allowed" });
  });

const viewDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * One value (the shape before multi-value filters) or several (any of them). No transform: the file round-trips exactly as written, so
 * saving a view never rewrites the scalar views next to it, and the old code still reads a file with only scalars.
 */
const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([
    item,
    z
      .array(item)
      .min(1)
      .max(MAX_FILTER_VALUES)
      .refine((list) => new Set(list).size === list.length, "must not contain duplicates"),
  ]);

/**
 * The filters of a saved view: the query parameters of /jobs (without sort and page), same names,
 * same meaning. A key that is absent is "not filtered"; the toggles are only ever stored as `true`
 * by the web app (a view with `filtered: false` is the same as one without the key).
 * On the Today page the dates are ignored: Today is today.
 */
export const viewFiltersSchema = z.strictObject({
  /** Free text (title, company, full JD text). */
  q: nonEmptyString.max(200).optional(),
  /** Source family (`channels.family`, e.g. linkedin). */
  source: oneOrMany(MULTI_VALUE_SCHEMAS.source).optional(),
  city: oneOrMany(MULTI_VALUE_SCHEMAS.city).optional(),
  workplace: oneOrMany(MULTI_VALUE_SCHEMAS.workplace).optional(),
  contract: oneOrMany(MULTI_VALUE_SCHEMAS.contract).optional(),
  status: oneOrMany(MULTI_VALUE_SCHEMAS.status).optional(),
  /** Application statuses (`new` = no application yet; `archived` = ignored), any of them. */
  app: z
    .array(MULTI_VALUE_SCHEMAS.app)
    .min(1)
    .refine((list) => new Set(list).size === list.length, "must not contain duplicates")
    .optional(),
  /** Rank value at least this. */
  minScore: z.number().int().min(0).max(MIN_SCORE_MAX).optional(),
  /** Stated annual salary (upper bound, EUR) at least this. */
  minSalary: z.number().int().min(0).max(MIN_SALARY_MAX).optional(),
  from: viewDate.optional(),
  to: viewDate.optional(),
  /** Only jobs that state a salary. */
  salary: z.boolean().optional(),
  /** Show the jobs the hard filter removed. */
  filtered: z.boolean().optional(),
  /** Hide jobs that need more German than me.yaml has. */
  hideLang: z.boolean().optional(),
  /** Only jobs with a high-value signal (`high_value` categories; was `t12` before the signal categories, renamed by the 1 -> 2 migration). */
  high: z.boolean().optional(),
  /** Only jobs with an AI trap, or none of them. */
  trap: z.enum(TRAP_FILTERS).optional(),
});
export type ViewFilters = z.infer<typeof viewFiltersSchema>;

const savedView = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase letters, digits or dashes"),
  name: nonEmptyString.max(60),
  /** Show this view as the default home view (at most one). */
  default: z.boolean().default(false),
  filters: viewFiltersSchema,
});
export type SavedView = z.infer<typeof savedView>;

/** config/interests.yaml (config_version 2) — signal categories, bonus cap, saved views, watched companies. */
export const interestsSchema = z.strictObject({
  signals: signalsSchema,
  /** Limits of the extraction. */
  limits: z
    .strictObject({
      /** Longest quote stored per signal; longer sentences are cut around the hit, longer AI quotes are dropped. */
      quote_max_chars: positiveInt.default(280),
      /** Signals kept per category and job (the bonus counts a category once anyway). */
      per_category_max: positiveInt.default(3),
      /** Benefit tags kept per job. */
      tags_max: positiveInt.default(12),
      /** How far before a hit an `exclude` match may start and still veto it. */
      exclude_lookbehind_chars: nonNegativeInt.default(30),
      /** The AI reads at most this many characters of a JD (the middle is cut when it is longer). */
      ai_max_jd_chars: positiveInt.default(12000),
      /** Also send JDs without any rule candidate to the AI (it may find phrases the vocabulary misses). Jobs with candidates go first. */
      ai_review_without_candidates: z.boolean().default(true),
      /** The AI sub-task stops for this cycle after this many jobs in a row the AI could not answer. */
      ai_stop_after_failures: positiveInt.default(3),
      /** The "try it on recent jobs" preview of /interests runs the rules on this many recent open jobs (no AI). */
      preview_jobs: positiveInt.max(2000).default(500),
      /** The preview stops after this many milliseconds of rule matching and reports the jobs it got through (it runs in the web process). */
      preview_time_budget_ms: positiveInt.max(10000).default(1500),
    })
    .default({ quote_max_chars: 280, per_category_max: 3, tags_max: 12, exclude_lookbehind_chars: 30, ai_max_jd_chars: 12000, ai_review_without_candidates: true, ai_stop_after_failures: 3, preview_jobs: 500, preview_time_budget_ms: 1500 }),
  /** Max total bonus (sum of the category weights) added to the match score. */
  bonus_cap: nonNegativeNumber,
  views: z.array(savedView).superRefine((views, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    views.forEach((view, index) => {
      if (ids.has(view.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "must not contain duplicates" });
      ids.add(view.id);
      const name = view.name.toLowerCase();
      if (names.has(name)) ctx.addIssue({ code: "custom", path: [index, "name"], message: "must not contain duplicates" });
      names.add(name);
    });
    const defaults = views.flatMap((view, index) => (view.default ? [index] : []));
    for (const index of defaults.slice(1)) ctx.addIssue({ code: "custom", path: [index, "default"], message: "only one view can be the default" });
  }),
  /** Single source for watched companies: names matched case-insensitively against sources.yaml (ats_boards) `name`; they always trigger a push, regardless of score. */
  watched_companies: stringList,
});

export type InterestsConfig = z.infer<typeof interestsSchema>;
