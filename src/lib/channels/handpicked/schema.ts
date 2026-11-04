import { z } from "zod";

/**
 * Wire shapes of the Handpicked Berlin job index (`GET /jobs/search-index.json`) and posting detail (`GET /jobs/d/{id}.json`),
 * checked against live responses in 2026-10. The index root is an ARRAY of postings (about 4000, a rolling ~30 days); the
 * detail is `{ id, descriptionHTML, url, company }`. Only the fields the channel reads are declared; both objects are stored as
 * delivered.
 */

/** Ids are hexadecimal; the id goes into a URL path, so anything else makes the entry unusable. */
export const ID_PATTERN = /^[0-9a-f]+$/i;

/** One index entry as the sweep reads it. `postedAt` is a date without time. */
export const indexEntrySchema = z.looseObject({
  id: z.string().regex(ID_PATTERN),
  title: z.string(),
  company: z.string(),
  /** Free text; several places joined with " · " ("Berlin · Munich"). */
  location: z.string().optional().default(""),
  /** Lower-case place slugs; empty for remote postings. */
  cities: z.array(z.string()).optional().default([]),
  /** Only set for remote postings. */
  remoteCountryCodes: z.array(z.string()).optional().default([]),
  /** `onsite` | `hybrid` | `remote` (onsite looks like the site's default, not a fact). */
  remoteType: z.string().optional().default(""),
  postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The employer's own posting URL. */
  url: z.string().min(1),
  category: z.string().optional(),
  isInternship: z.boolean().optional(),
  tier: z.string().optional(),
  companyDomain: z.string().optional(),
  salaryRange: z.string().optional(),
});
export type HandpickedIndexEntry = z.infer<typeof indexEntrySchema>;

/** The index: an array, its entries stay `unknown` until each is checked on its own. */
export const indexSchema = z.array(z.unknown());

/** The detail record of one posting. */
export const detailSchema = z.looseObject({
  id: z.string(),
  descriptionHTML: z.string(),
  url: z.string().optional(),
  company: z.string().optional(),
});
export type HandpickedDetail = z.infer<typeof detailSchema>;

/** What is stored per posting: the index entry and the detail, both as delivered. */
export const storedPayloadSchema = z.looseObject({
  index: z.looseObject({
    id: z.string(),
    title: z.string(),
    company: z.string(),
    location: z.string().optional().default(""),
    cities: z.array(z.string()).optional().default([]),
    remoteType: z.string().optional().default(""),
    postedAt: z.unknown().optional(),
    url: z.string().optional(),
    category: z.string().optional(),
    isInternship: z.boolean().optional(),
    tier: z.string().optional(),
    companyDomain: z.string().optional(),
    salaryRange: z.string().optional(),
  }),
  detail: detailSchema,
});
export type HandpickedStoredPayload = z.infer<typeof storedPayloadSchema>;
