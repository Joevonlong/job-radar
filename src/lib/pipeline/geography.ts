import type { JobLocation } from "@/lib/domain/types";
import type { Market } from "@/lib/market/types";

import { foldDiacritics } from "./fold";

/**
 * Location normalization, ported from the legacy `normalize.ts` (the tables come from the market packs). City
 * names are canonicalised so the same city spelled differently by two sources (München / Munich) gives the same dedupe
 * key; the canonical names of the generic pack's city table are part of that key and never change.
 *
 * The country of a location text, in this order:
 * 1. the country named LAST in the text (country rules and state codes such as "Austin, TX") when that country has
 *    no city in the city table: that country, no city ("Dublin, CA" -> US, not Dublin in Ireland);
 * 2. the city table (first match): the city and its country;
 * 3. the country rules in table order (first match);
 * 4. for the home country only: the city written before the country name ("Bochum, Deutschland").
 * While `resolve_world_countries` is off (the behaviour before the market packs), step 1 gives no country at all.
 */

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The market's location tables, compiled once per market object. */
export interface Geography {
  market: Market;
  cityPatterns: ReadonlyArray<readonly [RegExp, string, string]>;
  /** Countries that have cities in the city table. */
  cityCountries: ReadonlySet<string>;
  /** Country rules in table order. */
  countryRules: ReadonlyArray<readonly [RegExp, string]>;
  /** "Austin, TX": state codes after a comma, a dash or a slash, per country (case-sensitive). */
  subdivisionRules: ReadonlyArray<readonly [RegExp, string]>;
  /** The country rules, then the subdivision rules, with the `g` flag: every mention in a text (`matchAll`). */
  mentionRules: ReadonlyArray<readonly [RegExp, string]>;
  /** The home country's names as whole words (explicit city extraction). */
  homeName: RegExp | null;
  nonCityLabel: RegExp | null;
  nonCityWords: readonly RegExp[];
}

/** A country name or alias as a whole word (letters and digits around it do not count). */
function namePattern(names: readonly string[]): string {
  return `(?<![\\p{L}\\p{N}])(?:${names.map((n) => escapePattern(n.toLocaleLowerCase("en"))).join("|")})(?![\\p{L}\\p{N}])`;
}

const compiled = new WeakMap<Market, Geography>();

export function compileGeography(market: Market): Geography {
  const hit = compiled.get(market);
  if (hit) return hit;
  const cityPatterns = Object.entries(market.cities).map(
    ([needle, [city, countryCode]]) => [new RegExp(`(^|[^\\p{L}])${escapePattern(needle)}(?=$|[^\\p{L}])`, "u"), city, countryCode] as const,
  );
  const countryRules = market.countries
    .filter((c) => c.match)
    .map((c) => [new RegExp(c.pattern ?? namePattern([c.name, ...c.aliases]), "iu"), c.code] as const);
  const subdivisionRules = Object.entries(market.subdivisionCodes)
    .filter(([, codes]) => codes.length > 0)
    .map(([country, codes]) => [new RegExp(`[,\\-\u2013/]\\s*(?:${codes.join("|")})\\b`, "u"), country] as const);
  const home = market.countries.find((c) => c.code === market.country);
  const geography: Geography = {
    market,
    cityPatterns,
    cityCountries: new Set(cityPatterns.map(([, , country]) => country)),
    countryRules,
    subdivisionRules,
    mentionRules: [...countryRules, ...subdivisionRules].map(([pattern, country]) => [new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), country] as const),
    homeName: home ? new RegExp(namePattern([home.name, ...home.aliases]), "iu") : null,
    nonCityLabel: market.nonCityLabels.length > 0 ? new RegExp(`^(?:${market.nonCityLabels.join("|")})(?:\\b|\\s)`, "iu") : null,
    nonCityWords: market.nonCityWords.map((p) => new RegExp(p, "iu")),
  };
  compiled.set(market, geography);
  return geography;
}

/** "Bochum, Deutschland" -> "Bochum": the place written before the home country's name, in the market's letter case. */
function explicitHomeCity(raw: string, geo: Geography): string | null {
  if (geo.homeName === null) return null;
  const global = new RegExp(geo.homeName.source, "giu");
  if (!geo.homeName.test(raw)) return null;
  const beforeCountry = (raw.split(global)[0] ?? "").replace(/[,(|/\-]+$/g, "").trim();
  const candidate = beforeCountry
    .split(/[,|/]/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!candidate || geo.nonCityLabel?.test(candidate) || geo.nonCityWords.some((p) => p.test(candidate)) || !/^[\p{L} .'-]{2,80}$/u.test(candidate)) return null;
  const locale = geo.market.locale;
  return candidate.replace(/\p{L}[\p{L}'’-]*/gu, (word) => `${word[0]?.toLocaleUpperCase(locale) ?? ""}${word.slice(1).toLocaleLowerCase(locale)}`);
}

/**
 * The country named last in the text when it has no city in the city table ("Remote - USA", "Dublin, CA"), else null.
 * `undefined`: no such country (go on with the city table).
 */
function outsideCityTable(raw: string, geo: Geography): string | undefined {
  let last: { end: number; country: string } | null = null;
  // matchAll works on a copy of the pattern: the shared one keeps its lastIndex
  for (const [pattern, country] of geo.mentionRules) {
    for (const m of raw.matchAll(pattern)) {
      const end = m.index + m[0].length;
      if (last === null || end > last.end) last = { end, country };
    }
  }
  const found = last as { end: number; country: string } | null;
  if (geo.market.resolveWorldCountries) return found !== null && !geo.cityCountries.has(found.country) ? found.country : undefined;
  // before the market packs: any mention of a country outside the city table's countries leaves the location without a country
  const outside = geo.countryRules.some(([pattern, country]) => !geo.cityCountries.has(country) && pattern.test(raw)) || geo.subdivisionRules.some(([pattern, country]) => !geo.cityCountries.has(country) && pattern.test(raw));
  return outside ? "" : undefined;
}

function lookupCity(city: string, geo: Geography): readonly [string, string] | undefined {
  const key = city.trim().toLocaleLowerCase();
  return Object.hasOwn(geo.market.cities, key) ? geo.market.cities[key] : undefined;
}

/** Location text -> city and country as far as the text says (null otherwise). */
export function normalizeLocation(raw: string, market: Market): JobLocation {
  const geo = compileGeography(market);
  const outside = outsideCityTable(raw, geo);
  if (outside !== undefined) {
    const country = outside === "" ? null : outside;
    return { label: raw, city: country !== null && country === market.country ? explicitHomeCity(raw, geo) : null, countryCode: country, isPrimary: false };
  }
  const lower = raw.toLocaleLowerCase();
  for (const [pattern, city, countryCode] of geo.cityPatterns) {
    if (pattern.test(lower)) return { label: raw, city, countryCode, isPrimary: false };
  }
  const countryCode = geo.countryRules.find(([pattern]) => pattern.test(raw))?.[1] ?? null;
  return { label: raw, city: countryCode !== null && countryCode === market.country ? explicitHomeCity(raw, geo) : null, countryCode, isPrimary: false };
}

export interface DraftLocation {
  label: string;
  city: string | null;
  countryCode: string | null;
}

/**
 * A channel's location, completed from its label where the channel left city or country empty.
 * What the channel states is kept (its country code is never overridden); the city is canonicalised.
 */
export function normalizeDraftLocation(location: DraftLocation, market: Market): JobLocation {
  const geo = compileGeography(market);
  const label = location.label.trim();
  const outside = outsideCityTable(label, geo);
  if (outside !== undefined) return { label, city: location.city?.trim() ?? null, countryCode: location.countryCode ?? (outside === "" ? null : outside), isPrimary: false };
  const parsed = normalizeLocation(label, market);
  const stated = location.city?.trim() ?? null;
  const known = stated === null ? undefined : lookupCity(stated, geo);
  const city = known?.[0] ?? stated ?? parsed.city;
  const countryCode = location.countryCode ?? known?.[1] ?? parsed.countryCode;
  return { label, city, countryCode, isPrimary: false };
}

/** The locations of a posting, the first one primary; blank duplicates dropped. */
export function normalizeDraftLocations(locations: readonly DraftLocation[], market: Market): JobLocation[] {
  const seen = new Set<string>();
  const result: JobLocation[] = [];
  for (const raw of locations) {
    const location = normalizeDraftLocation(raw, market);
    const key = locationKey(location);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(location);
  }
  if (result[0]) result[0] = { ...result[0], isPrimary: true };
  return result;
}

/**
 * Lower-case slug: ß as ss, diacritics folded (`foldDiacritics`), letters and digits of every script kept ("東京" stays
 * "東京", it is not the empty slug of every other city in another script), runs of anything else one "-".
 */
export function slugify(value: string): string {
  return foldDiacritics(value.replace(/[ßẞ]/g, "ss"))
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .normalize("NFC")
    .slice(0, 72);
}

/** Identity of one location for dedupe: its city when known, else the label. */
export function locationKey(location: Pick<JobLocation, "label" | "city" | "countryCode">): string {
  return `${location.countryCode ?? "xx"}:${slugify(location.city ?? location.label)}`;
}

/** Cities of a posting (slugs); locations without a city are ignored. */
export function cityKeys(locations: ReadonlyArray<Pick<JobLocation, "city">>): Set<string> {
  const keys = new Set<string>();
  for (const location of locations) if (location.city) keys.add(slugify(location.city));
  return keys;
}
