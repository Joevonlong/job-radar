import { z } from "zod";

/**
 * Wire shapes of JSearch (OpenWeb Ninja, sold on RapidAPI). Sources, checked 2026-10-07:
 *  - product page https://www.openwebninja.com/api/jsearch (sample job record),
 *  - OpenAPI file https://openwebninja.s3.us-east-1.amazonaws.com/portal/openapi/jsearch.yaml
 *    (`/search-v2` and `/job-details` records, field names, enums),
 *  - the RapidAPI listing `GET https://jsearch.p.rapidapi.com/search` the spec names.
 * The OpenAPI file documents `data` of `/search-v2` as `{ jobs: [...], cursor }` and of `/job-details`
 * as an array; the older RapidAPI `/search` returns `data` as an array. The envelope accepts both.
 *
 * Only fields the channel reads are declared; everything else stays in the stored payload untouched
 * (C1). Every field except the id is optional or nullable: the API sends null for what a source does
 * not state, and one malformed record must not cost the whole page (records are validated one by one).
 */

const text = z.string().nullish();

export const applyOptionSchema = z.looseObject({
  apply_link: text,
  publisher: text,
  is_direct: z.boolean().nullish(),
});
export type JsearchApplyOption = z.infer<typeof applyOptionSchema>;

export const jobSchema = z.looseObject({
  /** Opaque id (base64 text); the input of `/job-details`. */
  job_id: z.string().trim().min(1),
  job_title: text,
  employer_name: text,
  employer_website: text,
  /** Site that published the listing ("LinkedIn", "Company Careers", ...). */
  job_publisher: text,
  job_employment_type: text,
  job_employment_types: z.array(z.string()).nullish(),
  job_apply_link: text,
  job_apply_is_direct: z.boolean().nullish(),
  apply_options: z.array(applyOptionSchema).nullish(),
  job_description: text,
  job_is_remote: z.boolean().nullish(),
  job_posted_at_timestamp: z.number().nullish(),
  job_posted_at_datetime_utc: text,
  job_location: text,
  job_city: text,
  job_state: text,
  job_country: text,
  job_google_link: text,
  job_salary: text,
  job_salary_string: text,
  job_min_salary: z.number().nullish(),
  job_max_salary: z.number().nullish(),
  /** HOUR | DAY | WEEK | MONTH | YEAR */
  job_salary_period: text,
  /** Not in the current OpenAPI file; older responses carry it. */
  job_salary_currency: text,
  /** AI enrichment (`onsite` | `remote` | `hybrid`), only on enriched responses. */
  work_arrangement: text,
  seniority_level: text,
});
export type JsearchJob = z.infer<typeof jobSchema>;

/** `GET /search` and `GET /job-details`: `data` is the list of records, or `{ jobs }` for `/search-v2`. */
export const responseSchema = z.looseObject({
  /** `OK`; anything else is an error answer. */
  status: z.string().nullish(),
  data: z.union([z.array(z.unknown()), z.looseObject({ jobs: z.array(z.unknown()) })]).nullish(),
});

/**
 * What a stored raw posting holds: the search record, plus the `/job-details` record when it was fetched.
 * `detail_source: "stored"` says the detail is one kept from an earlier cycle and used for its description only (see
 * `parseJsearchPayload`); a freshly fetched detail and "no detail" carry no such key. Any other value does not parse.
 */
export const payloadSchema = z.object({
  search: jobSchema,
  detail: jobSchema.nullish(),
  detail_source: z.literal("stored").optional(),
});
export type JsearchPayload = z.infer<typeof payloadSchema>;

/** The records of a response body, unvalidated (each is checked separately by the caller). */
export function recordsOf(body: z.infer<typeof responseSchema>): unknown[] {
  const data = body.data;
  if (data === null || data === undefined) return [];
  return Array.isArray(data) ? data : data.jobs;
}

/** Whether a record has no description to speak of (missing, null, empty or only white space): the one judgement the channel and the parser share. */
export function lacksDescription(record: unknown): boolean {
  const value = typeof record === "object" && record !== null ? (record as Record<string, unknown>).job_description : undefined;
  return (typeof value === "string" ? value : "").trim() === "";
}
