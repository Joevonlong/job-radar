import { z } from "zod";

/**
 * Wire shapes of the Berlin Startup Jobs WordPress REST API (`/wp-json/wp/v2/...`, checked against live responses in 2026-10).
 * Posts are read with a field whitelist (`POST_FIELDS`): the full post object also carries the poster's order and submission
 * data, which must never be stored. The whitelist is the shape of the interface, not a setting.
 *
 * Only the fields the channel reads are declared; the stored post is the whitelisted object as delivered (C1).
 */

/** The `_fields` of a posts request, and the keys kept of a post before it is stored (the second guard, if the server ignores `_fields`). */
export const POST_FIELDS = [
  "id",
  "date",
  "date_gmt",
  "modified_gmt",
  "slug",
  "status",
  "link",
  "title",
  "content",
  "categories",
  "tags",
  "job_company",
  "job_location",
  "job_plan",
  "_unpublish_on",
  "_is_featured",
] as const;

/** The `_fields` of a term request, and the keys kept of a term. */
export const TERM_FIELDS = ["id", "name", "slug", "link"] as const;

const idList = z.array(z.number().int()).optional().default([]);

/** The post fields every use needs. */
const postShape = {
  /** Stable across re-listing and title edits: the external id. */
  id: z.number().int().positive(),
  slug: z.string().optional(),
  /** The posting's page on berlinstartupjobs.com (the API has no apply link). */
  link: z.string().optional(),
  /** HTML with entities (`&#8211;`), usually "Role // Company". */
  title: z.looseObject({ rendered: z.string() }),
  /** The description, HTML. */
  content: z.looseObject({ rendered: z.string() }),
  categories: idList,
  tags: idList,
  /** Exactly one company term per post. */
  job_company: idList,
  job_location: idList,
  job_plan: idList,
  /** `YYYY-MM-DD`: the day the employer's package ends. The site keeps the post up after it. */
  _unpublish_on: z.string().nullish(),
  _is_featured: z.boolean().nullish(),
};

/** One post as the scan reads it: `date_gmt` (site time without a zone) decides the age. */
export const postSchema = z.looseObject({ ...postShape, date_gmt: z.string() });
export type BerlinStartupJobsPost = z.infer<typeof postSchema>;

/** A stored post as `parse` and `descriptionHtml` read it: a `date_gmt` that is not a date only costs the date. */
export const storedPostSchema = z.looseObject({ ...postShape, date_gmt: z.unknown().optional() });
export type StoredBerlinStartupJobsPost = z.infer<typeof storedPostSchema>;

/** A `job_company` / `job_location` term. */
export const termSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  link: z.string().optional(),
});
export type BerlinStartupJobsTerm = z.infer<typeof termSchema>;

/** What is stored per posting: the post and the terms it points to. No value in it changes between runs. */
export const envelopeSchema = z.looseObject({
  post: storedPostSchema,
  terms: z.looseObject({
    job_company: z.array(termSchema).optional().default([]),
    job_location: z.array(termSchema).optional().default([]),
  }),
});
export type BerlinStartupJobsEnvelope = z.infer<typeof envelopeSchema>;
