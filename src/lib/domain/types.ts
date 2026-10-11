import { z } from "zod";

import { SALARY_PERIODS } from "@/lib/channels/types";

/** Domain vocabulary of the `jobs` table. Values a posting does not state are `unknown` (C3). */

export const SENIORITIES = ["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager", "unknown"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const CONTRACTS = ["permanent", "fixed_term", "freelance", "temp_agency", "student", "unknown"] as const;
export type Contract = (typeof CONTRACTS)[number];

/**
 * `none`: the posting says German is not needed. `preferred`: German is only a plus / nice to have
 * (never a requirement: no deduction). `unknown`: it does not say.
 */
export const GERMAN_LEVELS = ["unknown", "none", "preferred", "A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type GermanLevel = (typeof GERMAN_LEVELS)[number];

/** The levels that are a requirement (a CEFR level): `none`, `preferred` and `unknown` are not. */
export type GermanRequirement = Exclude<GermanLevel, "unknown" | "none" | "preferred">;

/** Whether the posting really requires German (a CEFR level). A "preferred" or "nice to have" German is not a requirement. */
export function isGermanRequirement(level: string): level is GermanRequirement {
  return level !== "unknown" && level !== "none" && level !== "preferred" && (GERMAN_LEVELS as readonly string[]).includes(level);
}

export const JOB_LANGUAGES = ["en", "de", "other", "unknown"] as const;
export type JobLanguage = (typeof JOB_LANGUAGES)[number];

export interface JobLocation {
  /** The location as the posting words it. */
  label: string;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
  isPrimary: boolean;
}

export const jobLocationSchema = z.object({
  label: z.string(),
  city: z.string().nullable(),
  countryCode: z.string().nullable(),
  isPrimary: z.boolean(),
});

const amountRange = z.object({ min: z.number().nullable(), max: z.number().nullable() });

/**
 * Why a stated salary is possibly another region's pay: its currency is not one of pipeline.yaml
 * `salary.local_currencies` (a USD range on a Berlin job), or the JD says the range is for another location
 * (`salary.other_region_patterns`: "our US benefits", "rates vary per country").
 */
export const OTHER_REGION_REASONS = ["currency", "description"] as const;
export type OtherRegionReason = (typeof OTHER_REGION_REASONS)[number];

/**
 * The currency `eurPerYear` of a stored salary is in: the name says it. Salaries stored before the market packs have only that
 * figure; they read as `basePerYear` in this currency (the market's base currency was always EUR then).
 */
export const LEGACY_BASE_CURRENCY = "EUR";

/**
 * `jobs.salary_json`. `min` / `max` / `period` are as the posting states them; `perYear` is the same
 * amounts in the same currency per year (period factors from pipeline.yaml); `basePerYear` is that in the market's base
 * currency `baseCurrency`, only when the currency is the base or pipeline.yaml gives a rate for it.
 * `eurPerYear` is written too while the base is EUR (older code reads it). Anything not stated stays null (C3).
 * Reading accepts both shapes: a salary without `baseCurrency` (stored before the market packs) has its EUR figure as the base.
 */
const storedJobSalarySchema = z.object({
  /** The salary text this was derived from. */
  raw: z.string(),
  currency: z.string().nullable(),
  period: z.enum(SALARY_PERIODS).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  perYear: amountRange.nullable(),
  /** Per year in `baseCurrency`. */
  basePerYear: amountRange.nullish(),
  baseCurrency: z.string().nullish(),
  /** Per year in EUR: written while the base currency is EUR (compatibility with older code). */
  eurPerYear: amountRange.nullish(),
  /** The period was not named; it was read as annual because the amount is too large for anything else. */
  periodAssumed: z.boolean(),
  /** Where the figures came from. */
  origin: z.enum(["channel", "text", "description"]),
  qualityStatus: z.enum(["valid", "review"]),
  reasonCodes: z.array(z.string()),
  /** Possibly another region's pay, and why; absent / null = nothing says so. Older rows lack the field. */
  otherRegion: z.enum(OTHER_REGION_REASONS).nullish(),
  /** The figure includes a variable part (OTE / on-target earnings), so it is not a base salary. Older rows lack the field. */
  includesVariable: z.boolean().nullish(),
});

export const jobSalarySchema = storedJobSalarySchema.transform((s) => {
  const legacy = s.baseCurrency === undefined || s.baseCurrency === null;
  return {
    ...s,
    basePerYear: legacy ? (s.eurPerYear ?? null) : (s.basePerYear ?? null),
    baseCurrency: legacy ? (s.eurPerYear ? LEGACY_BASE_CURRENCY : null) : (s.baseCurrency ?? null),
    eurPerYear: s.eurPerYear ?? null,
  };
});
export type JobSalary = z.infer<typeof jobSalarySchema>;
/** What is written to `salary_json` (`basePerYear` and `baseCurrency` always set by the pipeline). */
export type StoredJobSalary = z.input<typeof jobSalarySchema>;
