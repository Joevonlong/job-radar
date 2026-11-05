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
  /** Empty: anywhere in the home country. */
  home_city: string;
  places: readonly { place: string; relocate: boolean }[];
}

/** Worldwide is always remote only, whatever a hand-written file or the command-line setup marks it as. */
const isWorldwide = (text: string): boolean => placeKey(text) === WORLDWIDE;

/** The wanted places as text, for pages and prompts: the home city, then the places I'd move to. */
export function wantedLocations(preferences: PlacePreferences): string[] {
  const moves = preferences.places.filter((entry) => entry.relocate && !isWorldwide(entry.place)).map((entry) => entry.place);
  return preferences.home_city.trim() === "" ? moves : [preferences.home_city, ...moves];
}

/** The wanted places that can be a city: what a page lists as cities. A country or region I'd move to is left out, a name the tables do not know stays. */
export function wantedCities(preferences: PlacePreferences, geo: PlaceGeo): string[] {
  return wantedLocations(preferences).filter((text) => {
    const kind = lookupPlace(text, geo)?.kind;
    return kind === undefined || kind === "city" || text === preferences.home_city;
  });
}

/** A code that stands for a country the tables do not list: kept as written, so a scope token from an old file still counts. */
const isCountryCode = (text: string): boolean => /^[A-Z]{2}$/.test(text);

/** The scope token of a remote-only place: a region's id or a country's code. A city or an unknown name has none. */
function scopeToken(text: string, geo: PlaceGeo): string | null {
  const place = lookupPlace(text, geo);
  if (place === null) return isCountryCode(text) ? text : null;
  if (place.token !== null) return place.token;
  if (place.kind === "country") return place.countries[0] ?? null;
  if (place.kind === "region") return regionId(place.name, geo);
  return null;
}

/**
 * The remote scope the score prompt names: Worldwide, the tokens of the remote-only places, else the home country. The prompt's
 * wording is part of what a stored score means, so it stays as it was; the filter reads `placeAreas`.
 */
export function wantedRemoteScope(preferences: PlacePreferences, geo: PlaceGeo): Exclude<RemoteScopeValue, "none"> {
  if (preferences.places.some((entry) => isWorldwide(entry.place))) return "worldwide";
  const remoteOnly = preferences.places.filter((entry) => !entry.relocate).map((entry) => entry.place);
  const tokens = [...new Set(remoteOnly.flatMap((text) => scopeToken(text, geo) ?? []))];
  return tokens.length > 0 ? { region: tokens } : "home_country";
}

/** A city, or a name the tables do not know, that a job's location is compared with by its text. */
export interface NamedPlace {
  text: string;
  /** The countries it counts in; null when not known, and then the text counts in any country. A place I'd move to also counts at home, where the same name may be meant. */
  countries: readonly string[] | null;
  /** On-site and hybrid jobs count here: the home city or a place I'd move to. */
  relocate: boolean;
}

/** What the location settings cover, read against the tables. */
export interface PlaceAreas {
  /** No home city: a location that states the home country counts. */
  anywhereInHome: boolean;
  /** The home city first, then the listed cities and unknown names. */
  named: readonly NamedPlace[];
  /** Countries of the listed countries and regions I'd move to: any location there counts. */
  moveCountries: ReadonlySet<string>;
  /** Worldwide is listed: a remote job counts wherever it is based. */
  worldwide: boolean;
  /** The home country and the countries of the listed countries and regions. */
  remoteCountries: ReadonlySet<string>;
  /** The regions a wide label may name: the listed ones and those holding a listed place. The home region is the caller's to add. */
  wideRegions: readonly string[];
}

/** The location settings as areas: what the filter and the ranking compare a job's location with. */
export function placeAreas(preferences: PlacePreferences, geo: PlaceGeo, homeCountry: string): PlaceAreas {
  const homeCity = preferences.home_city.trim();
  const named: NamedPlace[] = homeCity === "" ? [] : [{ text: homeCity, countries: [homeCountry], relocate: true }];
  const moveCountries = new Set<string>();
  const remoteCountries = new Set<string>([homeCountry]);
  const abroad = new Set<string>();
  const wideRegions = new Set<string>();
  let worldwide = false;
  for (const { place: text, relocate } of preferences.places) {
    const place = lookupPlace(text, geo);
    if (place?.kind === "worldwide") {
      worldwide = true;
    } else if (place?.kind === "city") {
      const inHomeToo = relocate && !place.countries.includes(homeCountry) ? [homeCountry] : [];
      named.push({ text, countries: place.countries.length > 0 ? [...place.countries, ...inHomeToo] : null, relocate });
      for (const country of place.countries) abroad.add(country);
    } else if (place === null && !isCountryCode(text)) {
      named.push({ text, countries: null, relocate });
    } else {
      const countries = place === null ? [text] : place.countries;
      for (const country of countries) {
        remoteCountries.add(country);
        if (place?.kind !== "region") abroad.add(country);
        if (relocate) moveCountries.add(country);
      }
      if (place?.kind === "region") wideRegions.add(regionId(place.name, geo) ?? place.name);
    }
  }
  abroad.delete(homeCountry);
  for (const [id, region] of Object.entries(geo.regions)) if (region.countries.some((country) => abroad.has(country))) wideRegions.add(id);
  return { anywhereInHome: homeCity === "", named, moveCountries, worldwide, remoteCountries, wideRegions: [...wideRegions] };
}

/** One search the location settings ask for. Query ids are made from `location`, `remote` and `remoteScope`, so these stay stable. */
export interface PlannedSearch {
  /** The text searched with; null for a remote search of a scope. */
  location: string | null;
  remote: boolean;
  remoteScope: Exclude<RemoteScopeValue, "none"> | null;
  /** The ISO code a board should search in; null when the place has no single known country. Never part of a query id. */
  country: string | null;
  /** The `places` entry this search comes from; null for the home searches. */
  place: string | null;
}

const singleCountry = (place: Place | null): string | null => (place?.countries.length === 1 ? (place.countries[0] ?? null) : null);

/** The remote search of one listed place, or null when it needs none. A town the tables do not know is most likely near home, so only one listed as remote only gets a search. */
function remoteSearchOf(text: string, relocate: boolean, geo: PlaceGeo, homeCountry: string): PlannedSearch | null {
  const place = lookupPlace(text, geo);
  const common = { remote: true, place: text };
  if (place?.kind === "worldwide") return { ...common, location: null, remoteScope: "worldwide", country: null };
  const token = place === null ? (isCountryCode(text) ? text : null) : place.token;
  if (token !== null) return { ...common, location: null, remoteScope: { region: [token] }, country: place === null ? text : singleCountry(place) };
  if (place === null || (place.kind === "city" && place.countries.length === 0)) return relocate ? null : { ...common, location: text, remoteScope: null, country: null };
  if (place.kind !== "region" && place.countries.includes(homeCountry)) return null;
  return { ...common, location: place.searchName, remoteScope: null, country: singleCountry(place) };
}

/**
 * The searches of the location settings, for each keyword group: the home city (the home country's name without one) and each place
 * I'd move to, then, when remote jobs are wanted, the home country unless a listed scope token or Worldwide covers it, and one per listed place. An
 * upgraded config whose preferences.yaml and search.yaml agreed keeps the queries it had, with the same ids, so its rotation history carries over,
 * and gains the remote search of a place abroad; `searchEntriesOutsidePlaces` and `placesBeyondSearchEntries` name the differences. Pure: the form counts with it too.
 */
export function plannedSearches(preferences: PlacePreferences & { workplace: readonly string[] }, geo: PlaceGeo, home: { country: string; countryName: string }): PlannedSearch[] {
  const onsite = { remote: false, remoteScope: null };
  const homeCity = preferences.home_city.trim();
  const searches: PlannedSearch[] = [{ ...onsite, location: homeCity === "" ? home.countryName : homeCity, country: home.country, place: null }];
  for (const { place: text, relocate } of preferences.places) {
    if (!relocate || isWorldwide(text)) continue;
    const place = lookupPlace(text, geo);
    searches.push({ ...onsite, location: place?.token ? place.searchName : text, country: singleCountry(place), place: text });
  }
  if (!preferences.workplace.includes("remote")) return searches;
  const coversHome = preferences.places.some(({ place: text }) => {
    const place = lookupPlace(text, geo);
    return place === null ? text === home.country : place.kind === "worldwide" || (place.token !== null && place.countries.includes(home.country));
  });
  if (!coversHome) searches.push({ location: null, remote: true, remoteScope: "home_country", country: home.country, place: null });
  for (const { place: text, relocate } of preferences.places) {
    const search = remoteSearchOf(text, relocate, geo, home.country);
    if (search !== null) searches.push(search);
  }
  return searches;
}

/** The keys search.yaml had before the location settings moved to preferences.yaml. */
export interface OldSearchEntries {
  locations?: unknown;
  remote_scope?: unknown;
}

const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

const hasScopeRegion = (scope: unknown): scope is { region: unknown } => typeof scope === "object" && scope !== null && "region" in scope;

/** The places search.yaml's old keys name. */
function oldSearchNames(search: OldSearchEntries): string[] {
  const scope = search.remote_scope;
  return [...textsOf(search.locations), ...(scope === "worldwide" ? ["Worldwide"] : hasScopeRegion(scope) ? textsOf(scope.region) : [])];
}

/** What search.yaml's old `locations` and `remote_scope` name that the location settings do not list: they are not searched any more. */
export function searchEntriesOutsidePlaces(search: OldSearchEntries, preferences: PlacePreferences, geo: PlaceGeo): string[] {
  const names = oldSearchNames(search);
  const listed = new Set([preferences.home_city, ...preferences.places.map((entry) => entry.place)].map((text) => samePlaceKey(text, geo)));
  return [...new Set(names.filter((name) => !listed.has(samePlaceKey(name, geo))))];
}

/**
 * What the location settings search that search.yaml's old keys did not: the searches an upgrade adds, each a cost on a paid board. A key the
 * file does not have says nothing. A search of the home country's remote jobs is named by the country.
 */
export function placesBeyondSearchEntries(search: OldSearchEntries, preferences: PlacePreferences & { workplace: readonly string[] }, geo: PlaceGeo, home: { country: string; countryName: string }): string[] {
  const hasLocations = Array.isArray(search.locations);
  const scope = search.remote_scope;
  if (!hasLocations && scope === undefined) return [];
  const HOME = "\0home";
  const scopeKey = (name: string): string => (samePlaceKey(name, geo) === samePlaceKey(home.country, geo) ? HOME : samePlaceKey(name, geo));
  const onsite = new Set(textsOf(search.locations).map((name) => samePlaceKey(name, geo)));
  const remote = new Set(scope === "worldwide" ? [WORLDWIDE] : scope === "home_country" ? [HOME] : hasScopeRegion(scope) ? textsOf(scope.region).map(scopeKey) : []);
  const remoteKey = (entry: PlannedSearch): string | null => {
    if (entry.remoteScope === "worldwide") return WORLDWIDE;
    if (entry.remoteScope === "home_country") return HOME;
    const token = entry.remoteScope?.region[0];
    return token === undefined ? null : scopeKey(token);
  };
  const isNew = (entry: PlannedSearch): boolean => {
    if (!entry.remote) return hasLocations && !onsite.has(samePlaceKey(entry.location ?? "", geo));
    if (scope === undefined) return false;
    const key = remoteKey(entry);
    return key === null || !remote.has(key);
  };
  const names = plannedSearches(preferences, geo, home).filter(isNew).map((entry) => entry.place ?? entry.location ?? home.countryName);
  return [...new Set(names)];
}
