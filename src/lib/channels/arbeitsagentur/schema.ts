import { z } from "zod";

/**
 * Wire shapes of the Bundesagentur für Arbeit Jobsuche API (verified live 2026-10: search
 * `/pc/v6/jobs`, detail `/pc/v4/jobdetails/{base64(refnr)}`; the older `/pc/v4/jobs` search and the
 * v3/v6 detail paths answer 403 now). Only fields the channel reads are declared; everything else
 * stays in the stored payload untouched (C1). Optional fields are optional because the API omits
 * them instead of sending null; the detail record also accepts null for them (see `detailSchema`).
 *
 * No contact person fields are declared or read (spec: contact data is not stored).
 */

const optionalString = z.string().optional();
const optionalNumber = z.number().optional();
const optionalBool = z.boolean().optional();

const addressFields = {
  plz: optionalString,
  ort: optionalString,
  region: optionalString,
  land: optionalString,
};
const coordinateFields = {
  breite: optionalNumber,
  laenge: optionalNumber,
};

export const locationSchema = z.looseObject({
  adresse: z.looseObject(addressFields).optional(),
  ...coordinateFields,
});
export type BaLocation = z.infer<typeof locationSchema>;

type Lenient<S> = { [K in keyof S]: S[K] extends z.ZodOptional ? z.ZodNullable<S[K]> : S[K] };

/** `shape` with every optional field also accepting null; required fields stay as they are. */
function lenient<S extends Record<string, z.ZodType>>(shape: S): Lenient<S> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, field instanceof z.ZodOptional ? field.nullable() : field]),
  ) as Lenient<S>;
}

/** A location of the detail record, read as leniently as the record itself. */
const detailLocationSchema = z.looseObject({
  adresse: z.looseObject(lenient(addressFields)).nullish(),
  ...lenient(coordinateFields),
});
export type BaDetailLocation = z.infer<typeof detailLocationSchema>;

/** Fields the list item and the detail record have in common. */
const postingFields = {
  referenznummer: z.string().trim().min(1),
  stellenangebotsart: optionalString,
  stellenangebotsTitel: optionalString,
  firma: optionalString,
  hauptberuf: optionalString,
  stellenlokationen: z.array(locationSchema).optional(),
  arbeitszeitVollzeit: optionalBool,
  arbeitszeitSchichtNachtWochenende: optionalBool,
  arbeitszeitTeilzeitAbend: optionalBool,
  arbeitszeitTeilzeitNachmittag: optionalBool,
  arbeitszeitTeilzeitVormittag: optionalBool,
  arbeitszeitTeilzeitFlexibel: optionalBool,
  istGeringfuegigeBeschaeftigung: optionalBool,
  vertragsdauer: optionalString,
  homeofficemoeglich: optionalBool,
  homeofficetyp: optionalString,
  homeofficeprozent: optionalNumber,
  verguetungsangabe: optionalString,
  artDerVerguetung: optionalString,
  festgehalt: optionalNumber,
  gehaltsspanneVon: optionalNumber,
  gehaltsspanneBis: optionalNumber,
  veroeffentlichungszeitraum: z.looseObject({ von: optionalString }).optional(),
  datumErsteVeroeffentlichung: optionalString,
  aenderungsdatum: optionalString,
  externeURL: optionalString,
  istArbeitnehmerUeberlassung: optionalBool,
  istPrivateArbeitsvermittlung: optionalBool,
};

/** One entry of `ergebnisliste` in a search response. */
export const searchItemSchema = z.looseObject({
  ...postingFields,
  entfernung: optionalNumber,
});
export type BaSearchItem = z.infer<typeof searchItemSchema>;

/** A page of search results. An empty result has no `ergebnisliste` at all. */
export const searchResponseSchema = z.object({
  ergebnisliste: z.array(searchItemSchema).optional().default([]),
  /** Total hits for the query across all pages (a number in v6, a string in the old v4 docs). */
  maxErgebnisse: z.coerce.number().int().nonnegative().optional().default(0),
  page: z.coerce.number().int().optional(),
  size: z.coerce.number().int().optional(),
});
export type BaSearchResponse = z.infer<typeof searchResponseSchema>;

/**
 * `/pc/v4/jobdetails/{id}`: the list fields plus the job description. One record is fetched per posting, so it is read
 * leniently: an optional field sent as null is kept as sent (and means "not stated"), so a single odd record does not
 * cost the posting its description.
 */
export const detailSchema = z.looseObject({
  ...lenient(postingFields),
  stellenlokationen: z.array(detailLocationSchema).nullish(),
  veroeffentlichungszeitraum: z.looseObject({ von: z.string().nullish() }).nullish(),
  stellenangebotsBeschreibung: z.string().nullish(),
});
export type BaDetail = z.infer<typeof detailSchema>;

/**
 * What the channel stores per posting (C1) and `parse` receives: the list item as delivered, plus
 * the detail record when it could be fetched. The JSON objects are kept verbatim except for
 * contact data redacted from the description text; see `redact.ts`.
 */
export const payloadSchema = z.object({
  list: searchItemSchema,
  detail: detailSchema.nullable(),
});
export type BaPayload = z.infer<typeof payloadSchema>;
