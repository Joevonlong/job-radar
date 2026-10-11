import { z } from "zod";

import { nonEmptyString, positiveInt } from "./common";

/** Longest time range /insights can show (a year of daily columns is already unreadable on a phone). */
const MAX_RANGE_DAYS = 366;

/**
 * config/insights.yaml — the /insights statistics page: which time ranges it offers,
 * which cities get their own row, and how the histograms are cut. Nothing here changes what is collected.
 */
export const insightsSchema = z
  .strictObject({
    /** Time ranges of the switch, in days, shortest first (the page counts back from today in the schedule's time zone). */
    ranges_days: z
      .array(positiveInt.max(MAX_RANGE_DAYS))
      .min(1)
      .refine((items) => new Set(items).size === items.length, "must not contain duplicates")
      .refine((items) => items.every((value, index) => index === 0 || (items[index - 1] ?? 0) < value), "must be sorted from shortest to longest"),
    /** The range shown when the URL names none (or one that is not in `ranges_days`). */
    default_range_days: positiveInt,
    /** Cities that get their own row in the city card, named as `locations_json[].city` spells them (München, not Munich). Everything else is "other". */
    cities: z
      .array(nonEmptyString)
      .refine((items) => new Set(items).size === items.length, "must not contain duplicates"),
    /** Rows of the "why jobs were filtered out" card. */
    top_filter_reasons: positiveInt,
    /** Width of a score histogram bucket (rank value points); the last bucket holds everything from `score_bucket_cap` up. */
    score_bucket_width: positiveInt,
    score_bucket_cap: positiveInt,
    /** Width of a salary histogram bucket (per year in the market's base currency, midpoint of the stated range; was `salary_bucket_eur`); the last bucket holds everything from `salary_bucket_cap` up. */
    salary_bucket: positiveInt,
    salary_bucket_cap: positiveInt,
  })
  .refine((c) => c.ranges_days.includes(c.default_range_days), { message: "must be one of ranges_days", path: ["default_range_days"] })
  .refine((c) => c.score_bucket_cap > c.score_bucket_width, { message: "must be larger than score_bucket_width", path: ["score_bucket_cap"] })
  .refine((c) => c.salary_bucket_cap > c.salary_bucket, { message: "must be larger than salary_bucket", path: ["salary_bucket_cap"] });

export type InsightsConfig = z.infer<typeof insightsSchema>;
