import { z } from "zod";

const countryCode = z.string().regex(/^[A-Z]{2}$/);
const name = z.string().trim().min(1);
const weight = z.number().min(0).max(100);

/** Every setting is required; the shipped YAML is the only source of defaults. */
export const jobSearchSchema = z.strictObject({
  query: z.strictObject({
    max_chars: z.number().int().min(10).max(1000),
    max_terms: z.number().int().min(1).max(50),
    cjk_min_chars: z.number().int().min(1).max(10),
  }),
  matching: z.strictObject({
    prefix_min_chars: z.number().int().min(1).max(20),
  }),
  ranking: z.strictObject({
    weights: z.strictObject({
      title: weight,
      company: weight,
      location: weight,
      country: weight,
      description: weight,
      translation: weight,
    }),
    prefix_factor: z.number().min(0).max(1),
  }),
  countries: z.strictObject({
    name_locales: z.array(z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)).min(1),
    ambiguous_codes: z.array(countryCode),
    extra_aliases: z.record(countryCode, z.array(name).min(1)),
  }),
  palette: z.strictObject({
    min_chars: z.number().int().min(1).max(10),
    limit: z.number().int().min(1).max(50),
  }),
});

export type JobSearchConfig = z.infer<typeof jobSearchSchema>;
