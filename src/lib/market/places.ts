/**
 * What a place name means, read against the market's tables: Worldwide, a region, a country or a city, in any spelling. One lookup,
 * so the filter, the ranking and the pages read a place alike. Which places exist is data (the packs' tables and
 * `filter.city_aliases`); nothing here names one. Pure.
 */
import type { CountryEntry } from "./schema";

/** The tables a place is looked up in. */
export interface PlaceGeo {
  /** `filter.city_aliases`: canonical city -> other spellings. */
  cityAliases: Readonly<Record<string, readonly string[]>>;
  /** `market.cities`: spelling (lower case) -> [canonical city, country]. */
  cities: Readonly<Record<string, readonly [string, string]>>;
  countries: readonly Pick<CountryEntry, "code" | "name" | "aliases">[];
  regions: Readonly<Record<string, { name: string; countries: readonly string[] }>>;
}

export type PlaceKind = "city" | "country" | "region" | "worldwide";

export interface Place {
  kind: PlaceKind;
  /** The tables' name for it. */
  name: string;
  /** ISO codes the place lies in. Empty for Worldwide (all of them) and for a city only `filter.city_aliases` knows. */
  countries: readonly string[];
  /** Every way to write it, the name first. */
  spellings: readonly string[];
  /** The text a board is searched with. */
  searchName: string;
  /** Set when the text is itself a remote scope token: a region's id (`eu`) or a country's code (`CH`). */
  token: string | null;
}

const WORLDWIDE = "worldwide";

/** The tables of a pipeline config. */
export function placeGeo(pipeline: { filter: { city_aliases: PlaceGeo["cityAliases"] }; market: Pick<PlaceGeo, "cities" | "countries" | "regions"> }): PlaceGeo {
  const { cities, countries, regions } = pipeline.market;
  return { cityAliases: pipeline.filter.city_aliases, cities, countries, regions };
}

/** Lower case, accents folded, spaces collapsed: "  ÖSTERREICH " and "osterreich" compare equal. */
function placeKey(value: string): string {
  return value.replace(/ß/g, "ss").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

/** `placeKey`, with the umlauts' "ae oe ue" spellings folded too, so "München", "Munchen" and "Muenchen" are one city. */
function citySpellingKey(value: string): string {
  return placeKey(value).replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
}

interface CityEntry {
  name: string;
  country: string | null;
  spellings: string[];
}

const addSpelling = (entry: CityEntry, spelling: string): void => {
  if (!entry.spellings.some((other) => placeKey(other) === placeKey(spelling))) entry.spellings.push(spelling);
};

function buildCityIndex(geo: Pick<PlaceGeo, "cityAliases" | "cities">): Map<string, CityEntry> {
  const index = new Map<string, CityEntry>();
  const register = (spelling: string, entry: CityEntry): void => {
    const key = citySpellingKey(spelling);
    if (!index.has(key)) index.set(key, entry);
  };
  // the aliases first: the name a user's own table gives a city stays its name
  for (const [canonical, aliases] of Object.entries(geo.cityAliases)) {
    const entry: CityEntry = { name: canonical, country: null, spellings: [canonical] };
    for (const alias of aliases) addSpelling(entry, alias);
    for (const spelling of entry.spellings) register(spelling, entry);
  }
  for (const [spelling, [canonical, country]] of Object.entries(geo.cities)) {
    const entry = index.get(citySpellingKey(spelling)) ?? index.get(citySpellingKey(canonical)) ?? { name: canonical, country, spellings: [canonical] };
    entry.country ??= country;
    if (entry.country === country) addSpelling(entry, spelling);
    register(spelling, entry);
    register(canonical, entry);
  }
  return index;
}

const cityIndexes = new WeakMap<PlaceGeo["cities"], WeakMap<PlaceGeo["cityAliases"], Map<string, CityEntry>>>();

function cityEntry(text: string, geo: Pick<PlaceGeo, "cityAliases" | "cities">): CityEntry | null {
  let byAliases = cityIndexes.get(geo.cities);
  if (byAliases === undefined) {
    byAliases = new WeakMap();
    cityIndexes.set(geo.cities, byAliases);
  }
  let index = byAliases.get(geo.cityAliases);
  if (index === undefined) {
    index = buildCityIndex(geo);
    byAliases.set(geo.cityAliases, index);
  }
  const key = citySpellingKey(text);
  return key === "" ? null : (index.get(key) ?? null);
}

/** The tables' name of a city ("Munich" -> "München"), else the text as written. */
export function canonicalCity(text: string, geo: Pick<PlaceGeo, "cityAliases" | "cities">): string {
  return cityEntry(text, geo)?.name ?? text;
}

/** Every spelling of a city, and the text as written. A name the tables do not know is only itself. */
export function citySpellings(text: string, geo: Pick<PlaceGeo, "cityAliases" | "cities">): string[] {
  const entry = cityEntry(text, geo);
  if (entry === null) return [text];
  return entry.spellings.some((other) => placeKey(other) === placeKey(text)) ? [...entry.spellings] : [...entry.spellings, text];
}

function findCountry(key: string, countries: PlaceGeo["countries"]): PlaceGeo["countries"][number] | null {
  return countries.find((c) => placeKey(c.code) === key) ?? countries.find((c) => placeKey(c.name) === key) ?? countries.find((c) => c.aliases.some((alias) => placeKey(alias) === key)) ?? null;
}

/** What `text` names: Worldwide, then a region, a country, a city. Null when the tables do not know it, which is not an error: no table has every town. */
export function lookupPlace(text: string, geo: PlaceGeo): Place | null {
  const written = text.trim();
  const key = placeKey(written);
  if (key === "") return null;
  if (key === WORLDWIDE) return { kind: "worldwide", name: "Worldwide", countries: [], spellings: ["Worldwide"], searchName: "Worldwide", token: null };
  for (const [id, region] of Object.entries(geo.regions)) {
    if (placeKey(id) === key || placeKey(region.name) === key) {
      return { kind: "region", name: region.name, countries: region.countries, spellings: [region.name, id], searchName: region.name, token: written === id ? id : null };
    }
  }
  const country = findCountry(key, geo.countries);
  if (country !== null) {
    return { kind: "country", name: country.name, countries: [country.code], spellings: [country.name, ...country.aliases], searchName: country.name, token: written === country.code ? country.code : null };
  }
  const city = cityEntry(written, geo);
  if (city === null) return null;
  return { kind: "city", name: city.name, countries: city.country === null ? [] : [city.country], spellings: [...city.spellings], searchName: city.name, token: null };
}
