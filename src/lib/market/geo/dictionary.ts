/**
 * The offline place dictionary: GeoNames cities with at least 15 000 inhabitants and all countries, with English,
 * German, Chinese and local names. Read-only; nothing here touches the network. Every spelling of a place (维也纳,
 * Viena, Wien, Vienna) finds the same entry, keyed by its GeoNames id. Lookups ignore case and accents, so `Zurich`
 * meets `Zürich`. The data is GeoNames (CC BY 4.0).
 */
import type { PlaceDictionaryFile } from "./format";

export type PlaceLang = "en" | "de" | "zh";
export type PlaceKind = "city" | "country";

/** One place as callers see it, with names resolved for the requested language (English when that one is missing). */
export interface Place {
  id: number;
  kind: PlaceKind;
  name: string;
  names: { en: string; de: string | null; zh: string | null };
  localName: string | null;
  searchName: string;
  countryCode: string;
  countryName: string;
  admin1: string | null;
  population: number;
  spellings: string[];
}

/** The dictionary language of a page locale (`zh-CN` -> zh); English for one the dictionary has no names in. */
export function placeLang(locale: string): PlaceLang {
  const language = locale.toLowerCase().split("-")[0];
  return language === "zh" || language === "de" ? language : "en";
}

export interface SearchOptions {
  lang?: PlaceLang;
  limit?: number;
  country?: string;
  kinds?: readonly PlaceKind[];
}

export interface MatchOptions {
  lang?: PlaceLang;
  country?: string;
  kinds?: readonly PlaceKind[];
}

interface Entry {
  id: number;
  kind: PlaceKind;
  canonical: string;
  en: string;
  de: string | null;
  zh: string | null;
  local: string | null;
  countryCode: string;
  admin1Code: string | null;
  population: number;
  spellings: string[];
  /** Its own names (canonical, ASCII, English, German, Chinese, local), as opposed to other spellings GeoNames lists. */
  primary: string[];
  primaryKeys: string[];
}

interface LocalisedName {
  en: string;
  de: string | null;
  zh: string | null;
}

/** What a place lookup reads from the dictionary: the shipped one on the server, or the few places a page already holds. */
export interface PlaceSource {
  getPlace(id: number, lang?: PlaceLang): Place | null;
  /** A country by its ISO code. */
  getCountry(code: string, lang?: PlaceLang): Place | null;
  matchPlaceName(text: string, options?: MatchOptions): Place[];
}

export interface PlaceDictionary extends PlaceSource {
  readonly meta: Pick<PlaceDictionaryFile, "source" | "licence" | "fetched" | "lastModified" | "counts">;
  searchPlaces(prefix: string, options?: SearchOptions): Place[];
}

const DEFAULT_LIMIT = 10;

const LETTER_FOLDS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * The comparison key of a name: Unicode-compatible form, lower case, accents removed, a few letters without a
 * decomposition folded (ß → ss), and punctuation that only separates words (hyphens, dots, apostrophes) read as a space.
 */
export function placeKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (letter) => LETTER_FOLDS[letter] ?? letter)
    .replace(/[\s\-‐‑–—_.,'’`·・]+/g, " ")
    .trim();
}

/** Like `placeKey` but keeping accents, so a typed `Mün` ranks Münster above a place that only folds to `mun`. */
function typedKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\-‐‑–—_.,'’`·・]+/g, " ")
    .trim();
}

function pick(names: LocalisedName, lang: PlaceLang): string {
  return names[lang] ?? names.en;
}

function primaryOf(names: readonly (string | null)[]): Pick<Entry, "primary" | "primaryKeys"> {
  const primary = names.filter((name): name is string => name !== null);
  return { primary, primaryKeys: primary.map(placeKey) };
}

function lowerBound(keys: readonly string[], value: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] ?? "") < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Builds a dictionary from the parsed file (the shipped one, or a small fixture in tests). */
export function createPlaceDictionary(file: PlaceDictionaryFile): PlaceDictionary {
  const admin1 = new Map<string, LocalisedName>(file.admin1.map(([code, en, de, zh]) => [code, { en, de, zh }]));
  const countryNames = new Map<string, LocalisedName>();
  const entries = new Map<number, Entry>();

  for (const [iso, id, en, de, zh, local, , population, other] of file.countries) {
    countryNames.set(iso, { en, de, zh });
    entries.set(id, {
      id,
      kind: "country",
      canonical: en,
      en,
      de,
      zh,
      local,
      countryCode: iso,
      admin1Code: null,
      population,
      spellings: [...new Set([en, de, zh, local, ...other].filter((s): s is string => s !== null))],
      ...primaryOf([en, de, zh, local]),
    });
  }
  for (const [id, name, ascii, iso, admin1Code, population, en, de, zh, local, other] of file.places) {
    entries.set(id, {
      id,
      kind: "city",
      canonical: name,
      en: en ?? name,
      de,
      zh,
      local,
      countryCode: iso,
      admin1Code,
      population,
      spellings: [...new Set([name, ascii, en, de, zh, local, ...other].filter((s): s is string => s !== null))],
      ...primaryOf([name, ascii, en, de, zh, local]),
    });
  }

  const index = new Map<string, number[]>();
  for (const entry of entries.values()) {
    for (const key of new Set(entry.spellings.map(placeKey))) {
      if (key === "") continue;
      const ids = index.get(key);
      if (ids === undefined) index.set(key, [entry.id]);
      else ids.push(entry.id);
    }
  }
  const sortedKeys = [...index.keys()].sort();
  const countryIds = new Map(file.countries.map(([iso, id]) => [iso, id]));

  const toPlace = (entry: Entry, lang: PlaceLang): Place => {
    const names = { en: entry.en, de: entry.de, zh: entry.zh };
    const country = countryNames.get(entry.countryCode);
    const division = entry.admin1Code === null ? undefined : admin1.get(entry.admin1Code);
    return {
      id: entry.id,
      kind: entry.kind,
      name: pick(names, lang),
      names,
      localName: entry.local,
      searchName: entry.local ?? entry.canonical,
      countryCode: entry.countryCode,
      countryName: country === undefined ? entry.countryCode : pick(country, lang),
      admin1: division === undefined ? null : pick(division, lang),
      population: entry.population,
      spellings: entry.spellings,
    };
  };

  const accepts = (entry: Entry, country: string | undefined, kinds: readonly PlaceKind[] | undefined): boolean =>
    (country === undefined || entry.countryCode === country.toUpperCase()) && (kinds === undefined || kinds.includes(entry.kind));

  const byPopulation = (a: Entry, b: Entry): number => b.population - a.population || a.id - b.id;

  return {
    meta: { source: file.source, licence: file.licence, fetched: file.fetched, lastModified: file.lastModified, counts: file.counts },

    /**
     * Ranks what a picker shows first: a place's own name typed in full, then another spelling typed in full, then places
     * whose own name starts with the text, then those where only another spelling does (so `Au` lists Australia and
     * Austria, not Kosovo through one of its other names). Within each, a spelling with the typed accents comes first, then
     * the larger place.
     */
    searchPlaces(prefix, options = {}) {
      const query = placeKey(prefix);
      const limit = options.limit ?? DEFAULT_LIMIT;
      if (query === "" || limit <= 0) return [];
      const exact = new Set(index.get(query) ?? []);
      const found = new Set<number>();
      for (let i = lowerBound(sortedKeys, query); i < sortedKeys.length; i += 1) {
        const key = sortedKeys[i] ?? "";
        if (!key.startsWith(query)) break;
        for (const id of index.get(key) ?? []) found.add(id);
      }
      const lang = options.lang ?? "en";
      const typed = typedKey(prefix);
      const tier = (entry: Entry): number => {
        if (entry.primaryKeys.includes(query)) return 0;
        if (exact.has(entry.id)) return 2;
        const ownPrefix = entry.primaryKeys.some((key) => key.startsWith(query));
        const accents = (ownPrefix ? entry.primary : entry.spellings).some((s) => typedKey(s).startsWith(typed)) ? 0 : 1;
        return (ownPrefix ? 4 : 6) + accents;
      };
      return [...found]
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => entry !== undefined && accepts(entry, options.country, options.kinds))
        .map((entry) => ({ entry, tier: tier(entry) }))
        .sort((a, b) => a.tier - b.tier || byPopulation(a.entry, b.entry))
        .map(({ entry }) => entry)
        .slice(0, limit)
        .map((entry) => toPlace(entry, lang));
    },

    getPlace(id, lang = "en") {
      const entry = entries.get(id);
      return entry === undefined ? null : toPlace(entry, lang);
    },

    getCountry(code, lang = "en") {
      const entry = entries.get(countryIds.get(code.toUpperCase()) ?? 0);
      return entry === undefined ? null : toPlace(entry, lang);
    },

    matchPlaceName(text, options = {}) {
      const lang = options.lang ?? "en";
      return (index.get(placeKey(text)) ?? [])
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => entry !== undefined && accepts(entry, options.country, options.kinds))
        .sort(byPopulation)
        .map((entry) => toPlace(entry, lang));
    },
  };
}

/**
 * A place source over places already looked up (each as `getPlace` gave it): what a page holds of the dictionary, which
 * the browser never loads whole. It answers like the dictionary for these places and knows no other.
 */
export function createPlaceSource(places: readonly Place[]): PlaceSource {
  const byId = new Map(places.map((place) => [place.id, place]));
  const accepts = (place: Place, options: MatchOptions): boolean =>
    (options.country === undefined || place.countryCode === options.country.toUpperCase()) && (options.kinds === undefined || options.kinds.includes(place.kind));
  return {
    getPlace: (id) => byId.get(id) ?? null,
    getCountry: (code) => places.find((place) => place.kind === "country" && place.countryCode === code.toUpperCase()) ?? null,
    matchPlaceName(text, options = {}) {
      const key = placeKey(text);
      if (key === "") return [];
      return [...byId.values()]
        .filter((place) => accepts(place, options) && place.spellings.some((spelling) => placeKey(spelling) === key))
        .sort((a, b) => b.population - a.population || a.id - b.id);
    },
  };
}
