import { z } from "zod";

/**
 * What the XING pages embed: `window.crate.serverData.APOLLO_STATE`, the normalized GraphQL
 * cache of the page. A search page holds the result list (`ROOT_QUERY.jobSearchByQuery(...)`) and one
 * `VisibleJob` entity per result; a posting page holds the `job(...)` entity plus a JSON-LD
 * `JobPosting`. Schemas are loose (XING adds fields without notice); raw objects are stored as they
 * came (C1).
 */

export const apolloStateSchema = z.record(z.string(), z.unknown());

const localized = z.looseObject({ id: z.string().nullish(), localizationValue: z.string().nullish() });

const salarySchema = z.looseObject({
  /** `SalaryRange` is what the employer states; `SalaryEstimate` is XING's own estimate (not a fact of the posting, C3). */
  __typename: z.string(),
  currency: z.string().nullish(),
  minimum: z.number().nullish(),
  maximum: z.number().nullish(),
  median: z.number().nullish(),
});

const locationSchema = z.looseObject({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.looseObject({ countryCode: z.string().nullish() }).nullish(),
});

const jobShape = {
  /** `157369813.d962f0`: the number is the posting id, the suffix a version hash. */
  id: z.string().regex(/^\d+(?:\.[0-9a-f]+)?$/i, "unexpected job id"),
  slug: z.string().min(1),
  title: z.string().trim().min(1),
  url: z.string().nullish(),
  /** Last refresh by the employer; the list has no date of first publication. */
  refreshedAt: z.string().nullish(),
  redirectsToThirdPartyUrl: z.boolean().nullish(),
  location: locationSchema.nullish(),
  locations: z.array(locationSchema).nullish(),
  employmentType: localized.nullish(),
  companyInfo: z.looseObject({ companyNameOverride: z.string().nullish() }).nullish(),
  salary: salarySchema.nullish(),
};

/** A `VisibleJob` of the result list, references resolved. */
export const listItemSchema = z.looseObject(jobShape);
export type XingListItem = z.infer<typeof listItemSchema>;

export const searchResultSchema = z.looseObject({
  collection: z.array(z.looseObject({ jobDetail: z.looseObject({ __ref: z.string() }) })),
  boundedTotal: z.looseObject({ total: z.number().nullish() }).nullish(),
});

/** A `VisibleJob` of a posting page (the `description` template is dropped: the JSON-LD carries the text, and the template has the contact block). */
export const jobSchema = z.looseObject({
  ...jobShape,
  activatedAt: z.string().nullish(),
  activeUntil: z.string().nullish(),
  /** FULL_REMOTE | PARTLY_REMOTE | NON_REMOTE */
  remoteOptions: z.array(z.string()).nullish(),
  /** ISO 639-1. */
  language: z.string().nullish(),
  careerLevel: localized.nullish(),
  discipline: localized.nullish(),
  industry: localized.nullish(),
  keywords: z.array(z.string()).nullish(),
  /** `UrlApplication` carries the employer's own apply URL. */
  application: z.looseObject({ __typename: z.string().nullish(), applyUrl: z.string().nullish() }).nullish(),
});
export type XingJob = z.infer<typeof jobSchema>;

export const detailSchema = z.object({
  /** JSON-LD `JobPosting`; `description` is plain text with contact data removed. */
  jsonLd: z.record(z.string(), z.unknown()).nullable(),
  job: jobSchema.nullable(),
  /** Description sections as text; only kept when the page has no JSON-LD description. */
  sections: z.array(z.object({ title: z.string().nullish(), text: z.string() })).nullish(),
});
export type XingDetail = z.infer<typeof detailSchema>;

/** The payload stored in `raw_postings`. */
export const payloadSchema = z.object({
  /** Absolute posting URL. */
  url: z.string(),
  list: listItemSchema,
  detail: detailSchema.nullable(),
});
export type XingPayload = z.infer<typeof payloadSchema>;
