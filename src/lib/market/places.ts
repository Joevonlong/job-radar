/**
 * What a place name means, read against the market's tables: Worldwide, a region, a country or a city, in any spelling. One lookup,
 * so the filter, the ranking and the pages read a place alike. Which places exist is data (the packs' tables and
 * `filter.city_aliases`); nothing here names one. Pure.
 */
import type { CountryEntry, RemoteScopeValue } from "./schema";

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

/** `placeKey`, with the umlauts' "ae oe ue" spellings folded too, so "München", "Munchen" and "Muenchen" meet. Only a fallback: it can make two cities ("Au", "Aue") collide. */
function citySpellingKey(value: string): string {
  return placeKey(value).replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
}

interface CityEntry {
  name: string;
  country: string | null;
  spellings: string[];
}

interface CityIndex {
  /** `placeKey` of a spelling -> its city. The first city to claim a spelling keeps it. */
  exact: Map<string, CityEntry>;
  /** `citySpellingKey` -> its city, or null when two cities share the folded key: then only the exact spelling finds either. */
  folded: Map<string, CityEntry | null>;
}

const addSpelling = (entry: CityEntry, spelling: string): void => {
  if (!entry.spellings.some((other) => placeKey(other) === placeKey(spelling))) entry.spellings.push(spelling);
};

function buildCityIndex(geo: Pick<PlaceGeo, "cityAliases" | "cities">): CityIndex {
  const entries: CityEntry[] = [];
  const byCity = new Map<string, CityEntry>();
  for (const [spelling, [canonical, country]] of Object.entries(geo.cities)) {
    const id = `${placeKey(canonical)}|${country}`;
    let entry = byCity.get(id);
    if (entry === undefined) {
      entry = { name: canonical, country, spellings: [canonical] };
      byCity.set(id, entry);
      entries.push(entry);
    }
    addSpelling(entry, spelling);
  }
  for (const [canonical, aliases] of Object.entries(geo.cityAliases)) {
    const names = [canonical, ...aliases];
    const hit = entries.filter((entry) => entry.spellings.some((spelling) => names.some((name) => placeKey(name) === placeKey(spelling))));
    const target = hit[0] ?? { name: canonical, country: null, spellings: [] };
    if (hit.length === 0) entries.push(target);
    for (const other of hit.slice(1)) {
      for (const spelling of other.spellings) addSpelling(target, spelling);
      entries.splice(entries.indexOf(other), 1);
    }
    for (const name of names) addSpelling(target, name);
    target.name = canonical;
    target.spellings = [canonical, ...target.spellings.filter((spelling) => placeKey(spelling) !== placeKey(canonical))];
  }
  const exact = new Map<string, CityEntry>();
  const folded = new Map<string, CityEntry | null>();
  for (const entry of entries) {
    for (const spelling of entry.spellings) {
      if (!exact.has(placeKey(spelling))) exact.set(placeKey(spelling), entry);
      const key = citySpellingKey(spelling);
      const seen = folded.get(key);
      folded.set(key, seen === undefined || seen === entry ? entry : null);
    }
  }
  return { exact, folded };
}

const cityIndexes = new WeakMap<PlaceGeo["cities"], WeakMap<PlaceGeo["cityAliases"], CityIndex>>();

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
  const key = placeKey(text);
  if (key === "") return null;
  return index.exact.get(key) ?? index.folded.get(citySpellingKey(text)) ?? null;
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

/** The id of a region the tables name. */
function regionId(name: string, geo: PlaceGeo): string | null {
  return Object.entries(geo.regions).find(([, region]) => region.name === name)?.[0] ?? null;
}

/** How a place is written in preferences.yaml: a region's id, a country's code, a city's name, else the text as written. */
export function storedPlaceName(text: string, geo: PlaceGeo): string {
  const place = lookupPlace(text, geo);
  if (place === null) return text.trim();
  if (place.kind === "region") return regionId(place.name, geo) ?? place.name;
  if (place.kind === "country") return place.countries[0] ?? place.name;
  return place.name;
}

/** Two texts with one key name one place. */
export function samePlaceKey(text: string, geo: PlaceGeo): string {
  return placeKey(storedPlaceName(text, geo));
}

/** The location part of preferences.yaml. */
export interface PlacePreferences {
  home_city: string;
  places: readonly { place: string; relocate: boolean }[];
}

/**
 * `home_city` and `places` as every reader takes them, whatever wrote them (the forms, the wizard, the CLI, an answers file,
 * the file edited by hand). The preferences schema runs it on every load and save; a reader with the market's tables runs it
 * again with them.
 * - Worldwide is remote only: nobody moves to "anywhere".
 * - A place that is the home city is dropped.
 * - A place named twice is one entry, at its first position. It is ✈ when any of them is, since moving there includes
 *   working remotely there.
 *
 * "Named twice" is `lookupPlace`'s reading with tables (Munich, München), else the text with case, accents and spaces ignored.
 * Unchanged input comes back as the same object.
 */
export function normalizePlaces<T extends PlacePreferences>(preferences: T, geo: PlaceGeo | null = null): T {
  const keyOf = (text: string): string => (geo === null ? placeKey(text) : samePlaceKey(text, geo));
  const home = keyOf(preferences.home_city);
  const byKey = new Map<string, { place: string; relocate: boolean }>();
  for (const entry of preferences.places) {
    const key = keyOf(entry.place);
    if (key === "" || key === home) continue;
    const relocate = entry.relocate && placeKey(entry.place) !== WORLDWIDE;
    const seen = byKey.get(key);
    byKey.set(key, seen === undefined ? { place: entry.place, relocate } : { ...seen, relocate: seen.relocate || relocate });
  }
  const places = [...byKey.values()];
  const same = places.length === preferences.places.length && places.every((entry, i) => entry.place === preferences.places[i]?.place && entry.relocate === preferences.places[i]?.relocate);
  return same ? preferences : { ...preferences, places };
}

/** The wanted cities as the filter's location rules read them: the home city, then the places I'd move to. */
export function wantedLocations(preferences: PlacePreferences): string[] {
  return [preferences.home_city, ...normalizePlaces(preferences).places.filter((entry) => entry.relocate).map((entry) => entry.place)];
}

/** The scope token of a country or region: a region's id or a country's code. A city or an unknown name has none. */
function scopeToken(text: string, geo: PlaceGeo): string | null {
  const place = lookupPlace(text, geo);
  if (place === null) return /^[A-Z]{2}$/.test(text) ? text : null;
  if (place.token !== null) return place.token;
  if (place.kind === "country") return place.countries[0] ?? null;
  if (place.kind === "region") return regionId(place.name, geo);
  return null;
}

/**
 * The remote scope the places add up to. Never `none`.
 * - Worldwide: `worldwide`.
 * - Countries and regions, remote-only and ✈ alike (moving there includes working remotely there): their tokens. With no
 *   remote-only one, the home country stays in, as it is the scope when no place names one.
 * - None of them: `home_country`.
 */
export function wantedRemoteScope(preferences: PlacePreferences, geo: PlaceGeo, homeCountry: string): Exclude<RemoteScopeValue, "none"> {
  const { places } = normalizePlaces(preferences, geo);
  if (places.some((entry) => lookupPlace(entry.place, geo)?.kind === "worldwide")) return "worldwide";
  const tokens = (relocate: boolean): string[] => places.filter((entry) => entry.relocate === relocate).flatMap((entry) => scopeToken(entry.place, geo) ?? []);
  const remoteOnly = tokens(false);
  if (remoteOnly.length > 0) return { region: [...new Set([...remoteOnly, ...tokens(true)])] };
  const moving = tokens(true).filter((token) => token !== homeCountry);
  return moving.length > 0 ? { region: [...new Set([homeCountry, ...moving])] } : "home_country";
}
