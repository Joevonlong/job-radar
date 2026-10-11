/** The stored shape of a checked salary lookup (`salary_lookups.result_json`), validated again when it is read. */
import { z } from "zod";

const nullableNumber = z.number().nullable();

export const salaryLookupQuerySchema = z.object({
  company: z.string(),
  title: z.string(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  seniority: z.string(),
  /** The market's base currency the figures were converted to. */
  currency: z.string(),
});
export type SalaryLookupQuery = z.infer<typeof salaryLookupQuerySchema>;

export const salarySourceSchema = z.object({
  url: z.string(),
  host: z.string(),
  site: z.string(),
  title: z.string(),
  excerpt: z.string(),
  /** The host is on `lookup.allowed_fetch_domains`; false = shown as "other source". */
  trusted: z.boolean(),
});
export type SalarySource = z.infer<typeof salarySourceSchema>;

export const salaryBandSchema = z.object({
  title: z.string(),
  seniority: z.string().nullable(),
  /** Per year in the base currency; null when not stated or not convertible. */
  min: nullableNumber,
  max: nullableNumber,
  median: nullableNumber,
  /** As the source states it. */
  original: z.object({ min: nullableNumber, max: nullableNumber, median: nullableNumber, currency: z.string().nullable() }),
  convertible: z.boolean(),
  basis: z.enum(["base", "total", "unknown"]),
  location: z.string().nullable(),
  /** Indexes into `sources`. */
  sources: z.array(z.number().int().nonnegative()),
});
export type SalaryBand = z.infer<typeof salaryBandSchema>;

export const salaryObservationSchema = z.object({
  family: z.string(),
  seniority: z.string(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  figure: z.number(),
});
export type SalaryObservation = z.infer<typeof salaryObservationSchema>;

export const salaryLookupResultSchema = z.object({
  query: salaryLookupQuerySchema,
  companyLevel: z.object({
    level: z.enum(["below", "market", "above", "top", "unknown"]),
    median: nullableNumber,
    summary: z.string(),
    sources: z.array(z.number().int().nonnegative()),
  }),
  roleBand: salaryBandSchema.nullable(),
  relatedRoles: z.array(salaryBandSchema),
  sources: z.array(salarySourceSchema),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string(),
  /** Items the checks removed (bad URL, no source, implausible figure). */
  dropped: z.number().int().nonnegative(),
  /** The bands that may enter the benchmark (`benchmark.include_ai_lookups`). */
  observations: z.array(salaryObservationSchema),
});
export type SalaryLookupResult = z.infer<typeof salaryLookupResultSchema>;
