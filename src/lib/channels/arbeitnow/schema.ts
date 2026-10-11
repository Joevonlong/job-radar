import { z } from "zod";

/**
 * Wire shapes of the Arbeitnow Job Board API (`GET /api/job-board-api?page=N`, checked against live responses in 2026-10).
 * A page is `{ data: [...], links: { first, last, prev, next }, meta: {...} }`; every posting has exactly ten fields. The page
 * size is not reliable (`meta.per_page` disagrees with what arrives), pages are cached separately and are not sorted inside,
 * so the channel reads `data` item by item and only trusts `links.next` as "there is another page".
 *
 * Only the posting fields the channel reads are declared; the object is stored as delivered (C1).
 */

const stringList = z.array(z.string()).optional().default([]);

/** The posting fields every use needs; `created_at` differs between the sweep (a number, or the item is dropped) and a stored payload. */
const postingShape = {
  /** Unique per posting (title slug plus a numeric suffix): the external id. */
  slug: z.string().trim().min(1),
  company_name: z.string(),
  title: z.string(),
  /** HTML with inline styles, ending in a "Find more ... on Arbeitnow" footer. */
  description: z.string().optional().default(""),
  remote: z.boolean().optional(),
  /** The posting's page on arbeitnow.com (the API has no direct apply link). */
  url: z.string().optional(),
  /** Free text ("Engineering"), not a fact the pipeline relies on. */
  tags: stringList,
  /** Free text in mixed languages and cases ("Full Time", "berufserfahren", "Internship"). */
  job_types: stringList,
  /** Free text ("Berlin", "Munich, Germany", "Hamburg or Berlin", "Remote"); empty when not given. */
  location: z.string().optional().default(""),
};

/** One posting as the sweep reads it: `created_at` (Unix seconds) decides whether it is inside the look-back window. */
export const jobSchema = z.looseObject({
  ...postingShape,
  created_at: z.number(),
});
export type ArbeitnowJob = z.infer<typeof jobSchema>;

/** A stored posting as `parse` and `descriptionHtml` read it: a `created_at` that is not a number only costs the date. */
export const storedJobSchema = z.looseObject({
  ...postingShape,
  created_at: z.unknown().optional(),
});
export type StoredArbeitnowJob = z.infer<typeof storedJobSchema>;

/** One page. `data` items stay `unknown` here: each is checked on its own, so one bad item does not cost the page. */
export const pageSchema = z.looseObject({
  data: z.array(z.unknown()),
  links: z.looseObject({ next: z.string().nullable().optional() }).optional(),
});
export type ArbeitnowPage = z.infer<typeof pageSchema>;
