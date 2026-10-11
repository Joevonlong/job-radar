import { z } from "zod";

/**
 * What the StepStone pages embed. The search page assigns its state to
 * `window.__PRELOADED_STATE__["app-unifiedResultlist"]`; a posting page carries a JSON-LD
 * `JobPosting` and `window.__PRELOADED_STATE__.JobAdContent`. Schemas are loose: StepStone adds
 * fields without notice, and the raw objects are stored as they came (C1).
 */

const salaryOnList = z.looseObject({
  /** "Predicted" marks StepStone's own estimate, which is not a fact of the posting (C3). */
  salaryType: z.string().nullish(),
  min: z.number().nullish(),
  max: z.number().nullish(),
  /** "Annually" | "Monthly" | ... */
  period: z.string().nullish(),
  currencyIso: z.string().nullish(),
});

/** One result of the search page (`searchResults.items[]`). */
export const listItemSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  /** Path of the posting page, with a tracking query. */
  url: z.string().min(1),
  companyName: z.string().nullish(),
  /** ISO timestamp with offset. */
  datePosted: z.string().nullish(),
  /** City list as StepStone words it ("Berlin, Hamburg", "Berlin, Berlin, Germany; Hamburg, ..."). */
  location: z.string().nullish(),
  /** "0" not stated, "1" home office only, "2" home office possible. */
  workFromHome: z.string().nullish(),
  /** main | semantic | regional | recommended: only the first two answer the search. */
  section: z.string().nullish(),
  isAnonymous: z.boolean().nullish(),
  unifiedSalary: salaryOnList.nullish(),
  harmonisedId: z.string().nullish(),
  textSnippet: z.string().nullish(),
});
export type StepstoneListItem = z.infer<typeof listItemSchema>;

export const searchStateSchema = z.looseObject({
  searchResults: z.looseObject({
    items: z.array(z.unknown()),
    pagination: z.looseObject({ page: z.number().optional(), pageCount: z.number().optional(), totalCount: z.number().optional() }).optional(),
    unifiedPagination: z.looseObject({ page: z.number().optional(), pageCount: z.number().optional() }).optional(),
  }),
});

/** The posting page's `JobAdContent.props`, as far as the channel reads it. */
export const jobAdContentSchema = z.looseObject({
  listingHeader: z
    .looseObject({
      listingData: z
        .looseObject({
          metaData: z
            .looseObject({
              contractType: z.string().nullish(),
              workType: z.string().nullish(),
              location: z.string().nullish(),
              onlineDate: z.string().nullish(),
            })
            .nullish(),
        })
        .nullish(),
      /** Salary StepStone shows next to the ad; `isPredicted` says whether it is its own estimate. */
      CESalary: z
        .looseObject({
          isPredicted: z.boolean().nullish(),
          min: z.number().nullish(),
          max: z.number().nullish(),
          /** German: Jahr | Monat | Woche | Tag | Stunde. */
          period: z.string().nullish(),
          currencyIso: z.string().nullish(),
        })
        .nullish(),
      language: z.string().nullish(),
    })
    .nullish(),
  offerLanguage: z.string().nullish(),
  textSections: z.array(z.looseObject({ name: z.string().nullish(), title: z.string().nullish(), content: z.string().nullish() })).nullish(),
});

/** What the channel keeps of a posting page. `jsonLd.description` and the section texts are plain text with contact data removed. */
export const detailSchema = z.object({
  jsonLd: z.record(z.string(), z.unknown()).nullable(),
  jobAd: z
    .object({
      metaData: z
        .object({
          contractType: z.string().nullish(),
          workType: z.string().nullish(),
          location: z.string().nullish(),
          onlineDate: z.string().nullish(),
        })
        .nullish(),
      salary: z
        .object({
          isPredicted: z.boolean().nullish(),
          min: z.number().nullish(),
          max: z.number().nullish(),
          period: z.string().nullish(),
          currencyIso: z.string().nullish(),
        })
        .nullish(),
      language: z.string().nullish(),
      /** Description sections (introduction, tasks, profile, ...) as text; only kept when the page has no JSON-LD description. */
      sections: z.array(z.object({ title: z.string().nullish(), text: z.string() })).nullish(),
    })
    .nullable(),
});
export type StepstoneDetail = z.infer<typeof detailSchema>;

/** The payload stored in `raw_postings`. */
export const payloadSchema = z.object({
  /** Absolute posting URL without the tracking query. */
  url: z.string(),
  list: listItemSchema,
  detail: detailSchema.nullable(),
});
export type StepstonePayload = z.infer<typeof payloadSchema>;
