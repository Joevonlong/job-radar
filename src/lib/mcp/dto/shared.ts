/** Shared field whitelists and conversions used by the MCP domain DTOs. */
import { z } from "zod";

import { SALARY_PERIODS } from "@/lib/channels/types";
import type { JobLocation, JobSalary, JobSourceRef } from "@/lib/db/queries/types";
import { OTHER_REGION_REASONS } from "@/lib/domain/types";

/** Cleans one short piece of third-party text (see `src/lib/mcp/guard.ts`). */
export type CleanText = (text: string) => string;

export const iso = z.string();
export const range = z.strictObject({ min: z.number().nullable(), max: z.number().nullable() });

export const linkDto = z.strictObject({
  /** The source family (e.g. `greenhouse`, `linkedin`). */
  source: z.string(),
  url: z.string().nullable(),
  apply_url: z.string().nullable(),
});

export const locationDto = z.strictObject({
  label: z.string(),
  city: z.string().nullable(),
  country_code: z.string().nullable(),
});

export const salaryDto = z.strictObject({
  /** The salary text as the posting states it. */
  raw: z.string(),
  currency: z.string().nullable(),
  period: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  per_year: range.nullable(),
  /** Per year in the market's base currency, when convertible. */
  base_per_year: range.nullable(),
  base_currency: z.string().nullable(),
  /** The parser was unsure; the figures may be wrong. */
  needs_review: z.boolean(),
  /** Possibly another region's pay, and why. */
  other_region: z.string().nullable(),
  includes_variable: z.boolean().nullable(),
});

export const rankDto = z.strictObject({
  /** The value the lists sort by (0-100). */
  rank_value: z.number().nullable(),
  /** The AI fit score (0-100). */
  score: z.number().nullable(),
  /** The profile changed since; a re-score is pending. */
  stale: z.boolean(),
});

/** Every result carries its notices (third-party text warning, trap header, truncation) first. */
export const notices = z.array(z.string());

export const isoOf = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function rangeOf(value: { min: number | null; max: number | null } | null | undefined): z.infer<typeof range> | null {
  return value ? { min: value.min, max: value.max } : null;
}

export function toLinkDto(source: JobSourceRef, clean: CleanText): z.infer<typeof linkDto> {
  return { source: source.family, url: source.url === null ? null : clean(source.url), apply_url: source.applyUrl === null ? null : clean(source.applyUrl) };
}

export function toLocationDto(location: JobLocation, clean: CleanText): z.infer<typeof locationDto> {
  return { label: clean(location.label), city: location.city === null ? null : clean(location.city), country_code: location.countryCode };
}

export function toSalaryDto(salary: JobSalary | null, clean: CleanText): z.infer<typeof salaryDto> | null {
  if (!salary) return null;
  return {
    raw: clean(salary.raw),
    currency: salary.currency,
    period: salary.period,
    min: salary.min,
    max: salary.max,
    per_year: rangeOf(salary.perYear),
    base_per_year: rangeOf(salary.basePerYear),
    base_currency: salary.baseCurrency,
    needs_review: salary.qualityStatus === "review",
    other_region: salary.otherRegion ?? null,
    includes_variable: salary.includesVariable ?? null,
  };
}

export function toRankDto(rank: { rankValue: number | null; score: number | null; stale: boolean } | null): z.infer<typeof rankDto> | null {
  return rank ? { rank_value: rank.rankValue, score: rank.score, stale: rank.stale } : null;
}

/**
 * The parts of a stored signal value that make an amount, read leniently (values written by older versions lack some fields).
 * Only these fields are ever read; anything else in the value is dropped.
 */
const storedRange = z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish() });
export const storedAmount = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  min: z.number().finite().nullish(),
  max: z.number().finite().nullish(),
  /** A fixed amount per year (older values). */
  amount: z.number().finite().nullish(),
  stated: z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish(), period: z.enum(SALARY_PERIODS) }).nullish(),
  basePerYear: storedRange.nullish(),
  eurPerYear: storedRange.nullish(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  periodAssumed: z.boolean().default(false),
  currencyAssumed: z.boolean().default(false),
  otherRegion: z.enum(OTHER_REGION_REASONS).nullish(),
});

export const bounds = (r: z.infer<typeof storedRange> | null | undefined) => (r ? { min: r.min ?? null, max: r.max ?? null } : null);
