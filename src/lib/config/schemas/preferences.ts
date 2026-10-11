import { z } from "zod";

import { marketSettingsSchema } from "@/lib/market/schema";

import { nonEmptyString, nonNegativeInt, regexString, remoteScope, slowPatternReason, stringList } from "./common";

const contractKind = z.enum(["permanent", "fixed_term", "freelance", "temp_agency"]);
const workplace = z.enum(["onsite", "hybrid", "remote"]);

const uniqueEnumList = <T extends z.ZodType>(item: T) =>
  z.array(item).refine((xs) => new Set(xs).size === xs.length, "must not contain duplicates");

/**
 * Upper bounds of `deal_breakers` that hold whatever pipeline.yaml says; the working limits (`filter.deal_breakers.max_rules`,
 * `max_pattern_chars`) are lower and checked against the file by `dealBreakerLimitProblems`.
 */
export const DEAL_BREAKER_HARD_LIMITS = { rules: 50, patternChars: 500, itemsPerList: 50, labelChars: 60 } as const;

/** CEFR levels a language gate can name as its threshold (`at_least`). */
export const DEAL_BREAKER_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

/** The schema message of a slow pattern; the profile form reads the kind back out of it (`issueKey`). */
export function slowPatternMessage(kind: string, detail: string): string {
  return `can be very slow (${kind}): ${detail}`;
}

/** A user pattern: a valid regular expression (flags "iu"), not too long, without the usual shapes of slow backtracking. */
const userPattern = regexString.max(DEAL_BREAKER_HARD_LIMITS.patternChars).superRefine((value, ctx) => {
  const slow = slowPatternReason(value);
  if (slow !== null) ctx.addIssue({ code: "custom", message: slowPatternMessage(slow.kind, slow.detail) });
});
const userPatterns = z.array(userPattern).max(DEAL_BREAKER_HARD_LIMITS.itemsPerList).default([]);

const dealBreakerBase = {
  /** Stable id: what `scores.filter_reasons` records (`deal_breaker:<id>`). */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "must be a slug: lower case letters, digits, - and _ (at most 40)"),
  /** Shown in the lists and on the detail page. */
  label: nonEmptyString.max(DEAL_BREAKER_HARD_LIMITS.labelChars),
  enabled: z.boolean().default(true),
};

/**
 * The market's local language: the posting requires a CEFR level (the pipeline's rule reading, `jobs.german_level_required`)
 * above the user's own level of that language in me.yaml (none listed = none at all). With `at_least` the threshold is
 * that level instead: a required level at or above it vetoes, me.yaml is not read. `preferred`, `none` and `unknown` never veto.
 */
const languageGate = z.strictObject({
  ...dealBreakerBase,
  type: z.literal("language_gate"),
  at_least: z.enum(DEAL_BREAKER_LEVELS).optional(),
});

/**
 * Words (`terms`: whole words, case and accents ignored) and / or regular expressions (`patterns`) in the title, the
 * description or either. A hit inside a sentence that matches one of `unless` does not count ("no travel required").
 */
const phrase = z
  .strictObject({
    ...dealBreakerBase,
    type: z.literal("phrase"),
    terms: z.array(nonEmptyString.max(DEAL_BREAKER_HARD_LIMITS.patternChars)).max(DEAL_BREAKER_HARD_LIMITS.itemsPerList).default([]),
    patterns: userPatterns,
    scope: z.enum(["title", "description", "any"]).default("any"),
    unless: userPatterns,
  })
  .refine((rule) => rule.terms.length + rule.patterns.length > 0, { message: "needs at least one term or pattern", path: ["terms"] });

/**
 * The visa check (docs/visa-sponsorship.md): the JD refuses visa sponsorship or asks for a work permit the candidate already has
 * (`not_offered`, either kind). Unclear and silent JDs never veto. Does nothing while me.yaml says `needs_visa_sponsorship: false`.
 */
const visaNotOffered = z.strictObject({
  ...dealBreakerBase,
  type: z.literal("visa_not_offered"),
});

export const dealBreakerSchema = z.discriminatedUnion("type", [languageGate, phrase, visaNotOffered]);
export type DealBreaker = z.infer<typeof dealBreakerSchema>;
export type DealBreakerType = DealBreaker["type"];
export const DEAL_BREAKER_TYPES = ["language_gate", "phrase", "visa_not_offered"] as const satisfies readonly DealBreakerType[];

export const dealBreakersSchema = z
  .array(dealBreakerSchema)
  .max(DEAL_BREAKER_HARD_LIMITS.rules)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      if (seen.has(rule.id)) ctx.addIssue({ code: "custom", message: `duplicate id "${rule.id}"`, path: [index, "id"] });
      seen.add(rule.id);
    });
  });

/** data/profile/preferences.yaml — what I want. */
export const preferencesSchema = z.strictObject({
  /** The market (pack, home country, base currency, local language); omitted values come from the pack. */
  market: marketSettingsSchema,
  target_titles: stringList.min(1),
  locations: stringList.min(1),
  workplace: uniqueEnumList(workplace).refine((w) => w.length > 0, "needs at least one workplace type"),
  remote_scope: remoteScope,
  seniority: z.enum(["all", "entry", "mid", "senior", "lead"]),
  /** Annual gross salary floor in the market's base currency (was `salary_floor_eur_year`); postings with a stated maximum below it are filtered out. */
  salary_floor_year: nonNegativeInt,
  contracts: z
    .strictObject({
      allow: uniqueEnumList(contractKind),
      exclude: uniqueEnumList(contractKind),
    })
    .refine((c) => !c.allow.some((kind) => c.exclude.includes(kind)), {
      message: "a contract type cannot be both allowed and excluded",
      path: ["exclude"],
    }),
  exclude_student_roles: z.boolean(),
  exclude_companies: z.array(nonEmptyString),
  exclude_keywords: z.array(nonEmptyString),
  /** Rules that veto a job before any AI call (the hard filter); optional, absent = none. */
  deal_breakers: dealBreakersSchema.default([]),
});

export type PreferencesConfig = z.infer<typeof preferencesSchema>;
