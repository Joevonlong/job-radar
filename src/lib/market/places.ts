/**
 * What a place name means, read against the market's tables and the offline place dictionary: Worldwide, a region, a country or
 * a city, in any spelling. One lookup, so the filter, the ranking and the pages read a place alike. Which places exist is data
 * (the packs' tables, `filter.city_aliases` and the dictionary); nothing here names one. Pure: the dictionary comes in with the
 * tables, the whole one on the server and the places a page already holds in the browser.
 */
import type { Place as Geoname, PlaceSource } from "./geo/dictionary";
import type { CountryEntry, RemoteScopeValue } from "./schema";

/** The tables a place is looked up in. */
export interface PlaceGeo {
  /** `filter.city_aliases`: canonical city -> other spellings. */
  cityAliases: Readonly<Record<string, readonly string[]>>;
  /** `market.cities`: spelling (lower case) -> [canonical city, country]. */
  cities: Readonly<Record<string, readonly [string, string]>>;
  countries: readonly Pick<CountryEntry, "code" | "name" | "aliases">[];
  regions: Readonly<Record<string, { name: string; countries: readonly string[] }>>;
  /** The place dictionary; absent or null when only the tables are read. */
  dictionary?: PlaceSource | null;
}

export type PlaceKind = "city" | "country" | "region" | "worldwide";

/** How a saved place is identified: a city's or country's GeoNames id, a region's id (`eu`), or `worldwide`. */
export type PlaceId = number | string;

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
  /** What a saved entry keeps to name it again: null for a city only the tables know. */
  id: PlaceId | null;
  /** The dictionary's entry, with names in the language it was read in; null when the dictionary does not know the place. */
  geoname: Geoname | null;
}

const WORLDWIDE = "worldwide";

/** The tables of a pipeline config, with the place dictionary (null: the tables alone). */
export function placeGeo(pipeline: { filter: { city_aliases: PlaceGeo["cityAliases"] }; market: Pick<PlaceGeo, "cities" | "countries" | "regions"> }, dictionary: PlaceSource | null): PlaceGeo {
  const { cities, countries, regions } = pipeline.market;
  return { cityAliases: pipeline.filter.city_aliases, cities, countries, regions, dictionary };
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

type CityGeo = Pick<PlaceGeo, "cityAliases" | "cities" | "dictionary">;

/** A city the tables or the dictionary know by this spelling; the tables first, so a name that is also a country stays a city here. */
function cityOf(text: string, geo: CityGeo): Place | null {
  const entry = cityEntry(text, geo);
  const dictionary = geo.dictionary ?? null;
  if (entry !== null) return cityPlace(entry, dictionary === null ? null : geonameOfCity(entry, dictionary));
  const found = dictionary?.matchPlaceName(text, { kinds: ["city"] })[0];
  return found === undefined ? null : cityPlace(tableCityOf(found, geo), found);
}

/** The tables' name of a city ("Munich" -> "München", "慕尼黑" -> "München"), else the text as written. */
export function canonicalCity(text: string, geo: CityGeo): string {
  return cityOf(text, geo)?.name ?? text;
}

/** Every spelling of a city, and the text as written. A name neither the tables nor the dictionary know is only itself. */
export function citySpellings(text: string, geo: CityGeo): string[] {
  const place = cityOf(text, geo);
  if (place === null) return [text];
  return place.spellings.some((other) => placeKey(other) === placeKey(text)) ? [...place.spellings] : [...place.spellings, text];
}

function findCountry(key: string, countries: PlaceGeo["countries"]): PlaceGeo["countries"][number] | null {
  return countries.find((c) => placeKey(c.code) === key) ?? countries.find((c) => placeKey(c.name) === key) ?? countries.find((c) => c.aliases.some((alias) => placeKey(alias) === key)) ?? null;
}

const unique = (texts: readonly string[]): string[] => {
  const seen = new Set<string>();
  return texts.filter((text) => {
    const key = placeKey(text);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** A country, from the tables' row and the dictionary's entry (either may be missing). */
function countryPlace(code: string, row: PlaceGeo["countries"][number] | null, geoname: Geoname | null, written: string): Place {
  const name = row?.name ?? geoname?.names.en ?? code;
  return { kind: "country", name, countries: [code], spellings: unique([name, ...(row?.aliases ?? []), ...(geoname?.spellings ?? [])]), searchName: name, token: written === code ? code : null, id: geoname?.id ?? null, geoname };
}

/** A city, from the tables' entry and the dictionary's entry (either may be missing). The tables' name wins: it is part of the dedup key. */
function cityPlace(entry: CityEntry | null, geoname: Geoname | null): Place | null {
  if (entry === null && geoname === null) return null;
  const name = entry?.name ?? geoname?.names.en ?? "";
  const country = entry?.country ?? geoname?.countryCode ?? null;
  return { kind: "city", name, countries: country === null ? [] : [country], spellings: unique([name, ...(entry?.spellings ?? []), ...(geoname?.spellings ?? [])]), searchName: name, token: null, id: geoname?.id ?? null, geoname };
}

/** The tables' entry of a dictionary city: one of its names, in its country (or in none). */
function tableCityOf(geoname: Geoname, geo: CityGeo): CityEntry | null {
  for (const name of [geoname.names.en, geoname.names.de, geoname.localName, geoname.name, ...geoname.spellings]) {
    if (name === null) continue;
    const entry = cityEntry(name, geo);
    if (entry !== null && (entry.country === null || entry.country === geoname.countryCode)) return entry;
  }
  return null;
}

/** The dictionary's entry of a city the tables know: one of its spellings, in its country. */
function geonameOfCity(entry: CityEntry, dictionary: PlaceSource): Geoname | null {
  const options = { kinds: ["city"] as const, ...(entry.country === null ? {} : { country: entry.country }) };
  for (const spelling of entry.spellings) {
    const found = dictionary.matchPlaceName(spelling, options)[0];
    if (found !== undefined) return found;
  }
  return null;
}

function placeOfGeoname(geoname: Geoname, geo: PlaceGeo, written: string): Place | null {
  if (geoname.kind === "country") return countryPlace(geoname.countryCode, geo.countries.find((c) => c.code === geoname.countryCode) ?? null, geoname, written);
  return cityPlace(tableCityOf(geoname, geo), geoname);
}

/**
 * What `text` names: Worldwide, then a region, a country, a city. A saved entry's `id` settles which place a shared name
 * means (Cambridge in England or in Massachusetts); without one, the tables come first, then the dictionary's largest place of
 * that name. Null when neither knows it: an old file may hold such a name, and it is then matched as written.
 */
export function lookupPlace(text: string, geo: PlaceGeo, id: PlaceId | null = null): Place | null {
  const written = text.trim();
  const key = placeKey(written);
  if (key === "") return null;
  if (key === WORLDWIDE) return { kind: "worldwide", name: "Worldwide", countries: [], spellings: ["Worldwide"], searchName: "Worldwide", token: null, id: WORLDWIDE, geoname: null };
  for (const [regionId, region] of Object.entries(geo.regions)) {
    if (placeKey(regionId) === key || placeKey(region.name) === key) {
      return { kind: "region", name: region.name, countries: region.countries, spellings: [region.name, regionId], searchName: region.name, token: written === regionId ? regionId : null, id: regionId, geoname: null };
    }
  }
  const dictionary = geo.dictionary ?? null;
  const picked = typeof id === "number" ? (dictionary?.getPlace(id) ?? null) : null;
  if (picked !== null) return placeOfGeoname(picked, geo, written);
  const country = findCountry(key, geo.countries);
  if (country !== null) return countryPlace(country.code, country, dictionary?.getCountry(country.code) ?? null, written);
  const city = cityEntry(written, geo);
  if (city !== null) return cityPlace(city, dictionary === null ? null : geonameOfCity(city, dictionary));
  const found = dictionary?.matchPlaceName(written)[0];
  return found === undefined ? null : placeOfGeoname(found, geo, written);
}

/** The id of a region the tables name. */
function regionId(name: string, geo: PlaceGeo): string | null {
  return Object.entries(geo.regions).find(([, region]) => region.name === name)?.[0] ?? null;
}

/** How a place is written in preferences.yaml: a region's id, a country's code, a city's name, else the text as written. */
export function storedPlaceName(text: string, geo: PlaceGeo, id: PlaceId | null = null): string {
  const place = lookupPlace(text, geo, id);
  if (place === null) return text.trim();
  if (place.kind === "region") return regionId(place.name, geo) ?? place.name;
  if (place.kind === "country") return place.countries[0] ?? place.name;
  return place.name;
}

/** Two entries with one key name one place: the place's id when it has one (so two cities called Cambridge stay two), else its stored name. */
export function samePlaceKey(text: string, geo: PlaceGeo, id: PlaceId | null = null): string {
  const place = lookupPlace(text, geo, id);
  if (place?.id !== null && place?.id !== undefined) return `#${place.id}`;
  return placeKey(storedPlaceName(text, geo, id));
}

/** One entry of `places`. `id` names the place for good once it was picked (see `PlaceId`); an old or hand-written entry may lack it. */
export interface PlaceEntry {
  place: string;
  relocate: boolean;
  id?: PlaceId | null | undefined;
}

/** The location part of preferences.yaml. */
export interface PlacePreferences {
  /** Empty: anywhere in the home country. */
  home_city: string;
  /** The home city's GeoNames id once it was picked. */
  home_city_id?: number | null | undefined;
  places: readonly PlaceEntry[];
}

const idOf = (entry: { id?: PlaceId | null | undefined }): PlaceId | null => entry.id ?? null;

/**
 * `home_city` and `places` as every reader takes them, whatever wrote them (the forms, the wizard, the CLI, an answers file,
 * the file edited by hand). The preferences schema runs it on every load and save; a reader with the market's tables runs it
 * again with them.
 * - Worldwide is remote only: nobody moves to "anywhere".
 * - A place that is the home city is dropped.
 * - A place named twice is one entry, at its first position. It is ✈ when any of them is, since moving there includes
 *   working remotely there.
 *
 * "Named twice" is `lookupPlace`'s reading with tables (Munich, München; an id first), else the id, else the text with case,
 * accents and spaces ignored. Unchanged input comes back as the same object.
 */
export function normalizePlaces<T extends PlacePreferences>(preferences: T, geo: PlaceGeo | null = null): T {
  const keyOf = (text: string, id: PlaceId | null): string => (geo !== null ? samePlaceKey(text, geo, id) : id !== null ? `#${id}` : placeKey(text));
  const home = keyOf(preferences.home_city, preferences.home_city_id ?? null);
  const byKey = new Map<string, PlaceEntry>();
  for (const entry of preferences.places) {
    const key = keyOf(entry.place, idOf(entry));
    if (key === "" || key === home) continue;
    const relocate = entry.relocate && placeKey(entry.place) !== WORLDWIDE;
    const seen = byKey.get(key);
    const id = seen === undefined ? idOf(entry) : (idOf(seen) ?? idOf(entry));
    byKey.set(key, { place: seen?.place ?? entry.place, relocate: (seen?.relocate ?? false) || relocate, ...(id === null ? {} : { id }) });
  }
  const places = [...byKey.values()];
  const same = places.length === preferences.places.length && places.every((entry, i) => entry.place === preferences.places[i]?.place && entry.relocate === preferences.places[i]?.relocate && idOf(entry) === idOf(preferences.places[i] ?? {}));
  return same ? preferences : { ...preferences, places };
}

/**
 * The names in the location settings that neither the market's tables nor the place dictionary know, the home city first. A save
 * refuses them unless the file already held them (an old file stays usable); the pages and `config:check` ask to pick them again.
 */
export function unknownPlaces(preferences: PlacePreferences, geo: PlaceGeo): string[] {
  const home = preferences.home_city.trim() !== "" && lookupPlace(preferences.home_city, geo, preferences.home_city_id ?? null) === null ? [preferences.home_city.trim()] : [];
  return [...home, ...preferences.places.filter((entry) => lookupPlace(entry.place, geo, idOf(entry)) === null).map((entry) => entry.place.trim())];
}

/** The text an entry keeps: as written when it is a spelling of the place, else the stored name (an id names the place, the text only labels it). */
function entryText(text: string, place: Place, stored: string, rename: boolean): string {
  return !rename && place.spellings.some((spelling) => placeKey(spelling) === placeKey(text)) ? text.trim() : stored;
}

/**
 * The location settings as a save writes them: each place once (`normalizePlaces`), each known one with its id. A text that is
 * not one of its place's spellings is replaced by the stored name; `rename` replaces every known one (the wizard, the command
 * line and an answers file, where any spelling may be typed). An unknown name is kept as written.
 */
export function resolvePlaces<T extends PlacePreferences>(preferences: T, geo: PlaceGeo, rename: boolean): T {
  const normal = normalizePlaces(preferences, geo);
  const places = normal.places.map((entry): PlaceEntry => {
    const place = lookupPlace(entry.place, geo, idOf(entry));
    if (place === null) return { place: entry.place.trim(), relocate: entry.relocate };
    const text = entryText(entry.place, place, storedPlaceName(entry.place, geo, idOf(entry)), rename);
    return place.id === null ? { place: text, relocate: entry.relocate } : { place: text, relocate: entry.relocate, id: place.id };
  });
  const rest: T = { ...normal };
  delete rest.home_city_id;
  const homeText = normal.home_city.trim();
  const home = homeText === "" ? null : lookupPlace(homeText, geo, normal.home_city_id ?? null);
  const homeCity = home === null ? homeText : entryText(homeText, home, home.kind === "city" ? home.name : homeText, rename);
  const homeId = typeof home?.id === "number" ? { home_city_id: home.id } : {};
  return { ...rest, home_city: homeCity, ...homeId, places };
}

/**
 * The country the tables put the home city in, when that is not the home country; null otherwise (or when the tables do not know the
 * city). An upgrade makes the first old location the home city without reading the tables, so `[Amsterdam, Berlin]` for a German market
 * gives a home city abroad: on-site jobs are then looked for in Amsterdam inside Germany.
 */
export function homeCityAbroad(homeCity: string, geo: PlaceGeo, homeCountry: string, homeCityId: number | null = null): { code: string; name: string } | null {
  const place = lookupPlace(homeCity, geo, homeCityId);
  const code = place?.kind === "city" && !place.countries.includes(homeCountry) ? place.countries[0] : undefined;
  if (code === undefined) return null;
  return { code, name: geo.countries.find((country) => country.code === code)?.name ?? code };
}

/** Worldwide is always remote only, whatever a hand-written file or the command-line setup marks it as. */
const isWorldwide = (text: string): boolean => placeKey(text) === WORLDWIDE;

/** The wanted places as text, for pages and prompts: the home city, then the places I'd move to. */
export function wantedLocations(preferences: PlacePreferences): string[] {
  const moves = normalizePlaces(preferences).places.filter((entry) => entry.relocate && !isWorldwide(entry.place)).map((entry) => entry.place);
  return preferences.home_city.trim() === "" ? moves : [preferences.home_city, ...moves];
}

/** The wanted places that can be a city: what a page lists as cities. A country or region I'd move to is left out, a name the tables do not know stays. */
export function wantedCities(preferences: PlacePreferences, geo: PlaceGeo): string[] {
  const ids = new Map<string, PlaceId | null>([...preferences.places.map((entry): [string, PlaceId | null] => [entry.place, idOf(entry)]), [preferences.home_city, preferences.home_city_id ?? null]]);
  return wantedLocations(preferences).filter((text) => {
    const kind = lookupPlace(text, geo, ids.get(text) ?? null)?.kind;
    return kind === undefined || kind === "city" || text === preferences.home_city;
  });
}

/** A code that stands for a country the tables do not list: kept as written, so a scope token from an old file still counts. */
const isCountryCode = (text: string): boolean => /^[A-Z]{2}$/.test(text);

/** The scope token of a country or region: a region's id or a country's code. A city or an unknown name has none. */
function scopeToken(text: string, geo: PlaceGeo, id: PlaceId | null): string | null {
  const place = lookupPlace(text, geo, id);
  if (place === null) return isCountryCode(text) ? text : null;
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
  if (places.some((entry) => lookupPlace(entry.place, geo, idOf(entry))?.kind === "worldwide")) return "worldwide";
  const tokens = (relocate: boolean): string[] => places.filter((entry) => entry.relocate === relocate).flatMap((entry) => scopeToken(entry.place, geo, idOf(entry)) ?? []);
  const remoteOnly = tokens(false);
  if (remoteOnly.length > 0) return { region: [...new Set([...remoteOnly, ...tokens(true)])] };
  const moving = tokens(true).filter((token) => token !== homeCountry);
  return moving.length > 0 ? { region: [...new Set([homeCountry, ...moving])] } : "home_country";
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
  /** Where I live or would move to: the home country and the countries of every place I'd move to. A posting that requires one of these can be taken. */
  liveCountries: ReadonlySet<string>;
  /** A place I'd move to has no country to compare, an unknown name: a posting that requires somewhere else may still be one I can take. */
  liveOpen: boolean;
  /** How a posting writes the places of `liveCountries` and any city I'd move to or live in. */
  liveSpellings: readonly string[];
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
  for (const entry of preferences.places) {
    const { place: text, relocate } = entry;
    const place = lookupPlace(text, geo, idOf(entry));
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
  const liveCountries = new Set([homeCountry, ...moveCountries, ...named.flatMap((place) => (place.relocate ? (place.countries ?? []) : []))]);
  const liveOpen = named.some((place) => place.relocate && place.countries === null);
  const liveSpellings = [
    ...geo.countries.filter((country) => liveCountries.has(country.code)).flatMap((country) => [country.name, ...country.aliases]),
    ...named.filter((place) => place.relocate).flatMap((place) => citySpellings(place.text, geo)),
    ...preferences.places.filter((entry) => entry.relocate).flatMap((entry) => {
      const place = lookupPlace(entry.place, geo);
      return place?.kind === "region" ? place.spellings : [];
    }),
  ];
  return { anywhereInHome: homeCity === "", named, moveCountries, liveCountries, liveOpen, liveSpellings, worldwide, remoteCountries, wideRegions: [...wideRegions] };
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
function remoteSearchOf(entry: PlaceEntry, geo: PlaceGeo, homeCountry: string): PlannedSearch | null {
  const { place: text, relocate } = entry;
  const place = lookupPlace(text, geo, idOf(entry));
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
  for (const entry of preferences.places) {
    const { place: text, relocate } = entry;
    if (!relocate || isWorldwide(text)) continue;
    const place = lookupPlace(text, geo, idOf(entry));
    searches.push({ ...onsite, location: place?.token ? place.searchName : text, country: singleCountry(place), place: text });
  }
  if (!preferences.workplace.includes("remote")) return searches;
  const coversHome = preferences.places.some((entry) => {
    const text = entry.place;
    const place = lookupPlace(text, geo, idOf(entry));
    return place === null ? text === home.country : place.kind === "worldwide" || (place.token !== null && place.countries.includes(home.country));
  });
  if (!coversHome) searches.push({ location: null, remote: true, remoteScope: "home_country", country: home.country, place: null });
  for (const entry of preferences.places) {
    const search = remoteSearchOf(entry, geo, home.country);
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

/** The scope tokens search.yaml's old `remote_scope` names, Worldwide as a name. */
function oldRemoteNames(scope: unknown): string[] {
  return scope === "worldwide" ? ["Worldwide"] : hasScopeRegion(scope) ? textsOf(scope.region) : [];
}

/**
 * What search.yaml's old `locations` and `remote_scope` name that the location settings do not search any more. An old location
 * needs the home city or a place I'd move to, since only those get an on-site search; an old scope token needs the home country or any
 * listed place. So a remote-only `CH` does not stand in for a dropped on-site `Switzerland`. With no home city the home country is
 * searched by name, so it counts as the home city.
 */
export function searchEntriesOutsidePlaces(search: OldSearchEntries, preferences: PlacePreferences, geo: PlaceGeo, home: { country: string; countryName: string }): string[] {
  const keys = (entries: readonly { place: string; id?: PlaceId | undefined }[]): Set<string> => new Set(entries.map((entry) => samePlaceKey(entry.place, geo, idOf(entry))));
  const { places } = normalizePlaces(preferences, geo);
  const named = (...texts: string[]): { place: string }[] => texts.map((place) => ({ place }));
  const homeNames = preferences.home_city.trim() === "" ? named(home.country, home.countryName) : [{ place: preferences.home_city, id: preferences.home_city_id }];
  const onsite = keys([...homeNames, ...places.filter((entry) => entry.relocate)]);
  const remote = keys([...named(home.country, home.countryName), ...places]);
  const dropped = [...textsOf(search.locations).filter((name) => !onsite.has(samePlaceKey(name, geo))), ...oldRemoteNames(search.remote_scope).filter((name) => !remote.has(samePlaceKey(name, geo)))];
  return [...new Set(dropped)];
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

/**
 * One choice of the place picker: what is saved (`place` and `id`) and how it is shown (`label`, and `detail` to tell places of
 * one name apart: the first-level division and the country). `record` is the dictionary's entry, which the page keeps so it can
 * read the place again without the dictionary; null for Worldwide and a region.
 */
export interface PlaceCandidate {
  id: PlaceId;
  kind: PlaceKind;
  place: string;
  label: string;
  detail: string;
  record: Geoname | null;
}

/** The picker's choice of a dictionary place, with its names in the language it was read in. */
export function placeCandidate(record: Geoname, geo: PlaceGeo): PlaceCandidate {
  const kind = record.kind;
  const detail = kind === "city" ? [record.admin1, record.countryName].filter((part): part is string => part !== null && part !== "" && part !== record.name).join(", ") : "";
  return { id: record.id, kind, place: storedPlaceName(record.names.en, geo, record.id), label: record.name, detail, record };
}
