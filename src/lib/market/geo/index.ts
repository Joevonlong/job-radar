/**
 * The shipped place dictionary (`config/geo/places.json.gz`, GeoNames, CC BY 4.0), loaded on first use and cached for
 * the life of the process. Read-only and offline. See `dictionary.ts` for the lookups.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { getAppRoot, getDefaultsDir } from "@/lib/config/paths";

import { createPlaceDictionary, type MatchOptions, type Place, type PlaceDictionary, type PlaceLang, type SearchOptions } from "./dictionary";
import { placeDictionaryFileSchema } from "./format";

export { createPlaceDictionary, createPlaceSource, placeKey, placeLang, type MatchOptions, type Place, type PlaceDictionary, type PlaceKind, type PlaceLang, type PlaceSource, type SearchOptions } from "./dictionary";
export { PLACE_DICTIONARY_FORMAT, placeDictionaryFileSchema, type PlaceDictionaryFile } from "./format";

export const PLACE_DICTIONARY_FILE = path.join("geo", "places.json.gz");

let cached: PlaceDictionary | null = null;

/**
 * Where the dictionary file is read from: the shipped defaults directory when it holds one (the images keep it at
 * `/app/config`), otherwise the repository's own `config/`, so a test or e2e run that points the defaults directory at a
 * fixture snapshot still gets the dictionary.
 */
export function placeDictionaryPath(): string {
  const candidates = [path.join(getDefaultsDir(), PLACE_DICTIONARY_FILE), path.join(getAppRoot(), "config", PLACE_DICTIONARY_FILE)];
  return candidates.find((file) => fs.existsSync(/*turbopackIgnore: true*/ file)) ?? candidates[candidates.length - 1] ?? "";
}

/** Reads and validates a dictionary file (gzip-compressed JSON). */
export function readPlaceDictionary(file: string): PlaceDictionary {
  const json: unknown = JSON.parse(zlib.gunzipSync(fs.readFileSync(/*turbopackIgnore: true*/ file)).toString("utf8"));
  return createPlaceDictionary(placeDictionaryFileSchema.parse(json));
}

/** The shipped dictionary, read on first call. */
export function placeDictionary(): PlaceDictionary {
  cached ??= readPlaceDictionary(placeDictionaryPath());
  return cached;
}

export function resetPlaceDictionaryCache(): void {
  cached = null;
}

/** Places whose spelling starts with `prefix`, exact matches first, then by population (for the place picker). */
export function searchPlaces(prefix: string, options?: SearchOptions): Place[] {
  return placeDictionary().searchPlaces(prefix, options);
}

export function getPlace(id: number, lang?: PlaceLang): Place | null {
  return placeDictionary().getPlace(id, lang);
}

/** Every place one of whose spellings is exactly `text` (ignoring case and accents); a shared name gives several. */
export function matchPlaceName(text: string, options?: MatchOptions): Place[] {
  return placeDictionary().matchPlaceName(text, options);
}
