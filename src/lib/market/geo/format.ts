/**
 * The on-disk format of the offline place dictionary (`config/geo/places.json.gz`), written by `pnpm geo:build`.
 * Rows are positional arrays to keep the shipped file small; `null` means "same as the canonical / English name" or
 * "not known". The data is GeoNames (CC BY 4.0).
 */
import { z } from "zod";

export const PLACE_DICTIONARY_FORMAT = 1;

const nullableName = z.string().min(1).nullable();

/** `[code "DE.02", en, de | null, zh | null]` */
const admin1Row = z.tuple([z.string().min(1), z.string().min(1), nullableName, nullableName]);

/** `[iso2, geonameId, en, de | null, zh | null, local | null, localLang, population, otherSpellings]` */
const countryRow = z.tuple([
  z.string().length(2),
  z.number().int().positive(),
  z.string().min(1),
  nullableName,
  nullableName,
  nullableName,
  z.string(),
  z.number().int().nonnegative(),
  z.array(z.string().min(1)),
]);

/** `[geonameId, name, ascii | null, iso2, admin1Code | null, population, en | null, de | null, zh | null, local | null, otherSpellings]` */
const placeRow = z.tuple([
  z.number().int().positive(),
  z.string().min(1),
  nullableName,
  z.string().length(2),
  nullableName,
  z.number().int().nonnegative(),
  nullableName,
  nullableName,
  nullableName,
  nullableName,
  z.array(z.string().min(1)),
]);

export const placeDictionaryFileSchema = z.object({
  format: z.literal(PLACE_DICTIONARY_FORMAT),
  source: z.string(),
  licence: z.string(),
  fetched: z.string(),
  lastModified: z.record(z.string(), z.string()),
  counts: z.object({
    places: z.number().int().nonnegative(),
    countries: z.number().int().nonnegative(),
    admin1: z.number().int().nonnegative(),
    placesWithZh: z.number().int().nonnegative(),
  }),
  admin1: z.array(admin1Row),
  countries: z.array(countryRow),
  places: z.array(placeRow),
});

export type PlaceDictionaryFile = z.infer<typeof placeDictionaryFileSchema>;
