import type { PipelineConfig } from "@/lib/config";
import { canonicalCity, citySpellings, lookupPlace, placeGeo } from "@/lib/market/places";
import { placeDictionary } from "@/lib/market/geo";
import { foldText, foldTransliterated, wholeWordPattern } from "@/lib/filter/rules";
import type { Market } from "@/lib/market/types";
import { normalizeLocation } from "@/lib/pipeline/geography";

/**
 * The city dropdown of /jobs. Sources spell places in many ways ("Garching", "Greater Munich
 * Metropolitan Area", "Nürnberg, Mittelfranken", "Munich"): the raw `locations_json[].city` values are folded
 * into one entry per city. A target city (the home city or a place to move to in preferences.yaml) takes in its aliases and the towns of
 * its metro area (pipeline.yaml `filter.city_aliases` / `filter.metro_areas`: the same tables the hard filter
 * uses), the other values go through the pipeline's city normalization. Pure: the database rows come in as data.
 */

export interface CityRow {
  jobId: number;
  /** `locations_json[].city` as stored. */
  city: string;
  label: string;
  countryCode: string | null;
}

export interface CityGroup {
  /** What the dropdown shows and the URL carries (`?city=`): the canonical city name. */
  key: string;
  /** The home city or a place to move to: listed first. */
  target: boolean;
  /** Distinct jobs with a location in this group. */
  jobCount: number;
  /** The raw `locations_json[].city` values that belong to the group (what the query matches). */
  members: string[];
}

export interface CityGroupConfig {
  /** The home city and the places to move to, in the user's order. */
  targets: readonly string[];
  /** The one among them that lies in the home country whatever the tables say, as in the filter. */
  homeCity?: string;
  filter: Pick<PipelineConfig["filter"], "city_aliases" | "metro_areas" | "metro_regions" | "country_level" | "generic_location_patterns">;
  /** The market: home country, transliterations and the city table. */
  market: Market;
}

interface Target {
  key: string;
  patterns: RegExp[];
  /** The countries a location of it can state; null: its text counts in any country. */
  countries: ReadonlySet<string> | null;
}

/** A location with no country, or one of the target's countries. */
const inCountriesOf = (row: Pick<CityRow, "countryCode">, target: Target): boolean => target.countries === null || row.countryCode === null || target.countries.has(row.countryCode);

function compileTargets(config: CityGroupConfig): Target[] {
  const geo = placeGeo(config, placeDictionary());
  const canonical = (name: string): string => canonicalCity(name, geo);
  const spellings = (name: string): string[] => citySpellings(name, geo);

  const targets: Target[] = [];
  for (const location of config.targets) {
    const looked = lookupPlace(location, geo);
    if (looked !== null && looked.kind !== "city" && location !== config.homeCity) continue;
    const key = canonical(location);
    if (targets.some((t) => t.key === key)) continue;
    const names = new Set<string>(spellings(location));
    for (const [city, towns] of Object.entries(config.filter.metro_areas)) {
      if (canonical(city) !== key) continue;
      for (const town of towns) for (const name of spellings(town)) names.add(name);
    }
    const patterns = new Map<string, RegExp>();
    for (const name of names) {
      for (const folded of [foldText(name), foldTransliterated(name, config.market.transliterations)]) if (!patterns.has(folded)) patterns.set(folded, wholeWordPattern(folded));
    }
    const tableCountries = looked?.countries ?? [];
    const countries = location === config.homeCity ? [config.market.country] : tableCountries.length > 0 ? [...tableCountries, config.market.country] : [];
    targets.push({ key, patterns: [...patterns.values()], countries: countries.length === 0 ? null : new Set(countries) });
  }
  return targets;
}

/** A value that names a region, a whole country or no place at all, not a place ("Bavaria", "Germany"): not a dropdown entry. */
function compileNonCities(config: CityGroupConfig): RegExp[] {
  const regions = Object.values(config.filter.metro_regions).flat().map((name) => wholeWordPattern(foldText(name)));
  const countries = config.filter.country_level.patterns.map((pattern) => new RegExp(pattern, "iu"));
  // "Home Office", "Remotely In": no place at all
  const generic = config.filter.generic_location_patterns.map((pattern) => new RegExp(pattern, "iu"));
  return [...regions, ...countries, ...generic];
}

/** The city a location stands for, after the pipeline's city normalization; its first comma part when that knows nothing. */
function otherCity(row: CityRow, market: Market): string | null {
  const normalized = normalizeLocation(row.city, market).city;
  if (normalized !== null) return normalized;
  const first = row.city.split(",", 1)[0]?.replace(/\s*\([^)]*\)/g, "").trim() ?? "";
  return first === "" ? null : first;
}

/** Where one stored location goes: a target city, another city (its key), or nowhere (a region, a country, no place). */
type Placement = { key: string; target: boolean } | null;

/**
 * Group the stored locations by city. Target cities come first in the order of `config.targets` (only
 * those with jobs), then the others, most jobs first; regions and country-level values are left out.
 * Where a location goes depends only on its (city, label, country code), and most jobs share a few
 * places, so each distinct one is placed once.
 */
export function buildCityGroups(rows: readonly CityRow[], config: CityGroupConfig): CityGroup[] {
  const targets = compileTargets(config);
  const nonCities = compileNonCities(config);
  const groups = new Map<string, { key: string; target: boolean; jobs: Set<number>; members: Set<string>; spellings: Map<string, number> }>();
  const placements = new Map<string, Placement>();
  // `otherCity` reads only the city value
  const otherCities = new Map<string, string | null>();

  const place = (row: CityRow): Placement => {
    const text = [foldText(row.city), foldText(row.label)];
    const target = targets.find((t) => inCountriesOf(row, t) && text.some((value) => value !== "" && t.patterns.some((pattern) => pattern.test(value))));
    if (target) return { key: target.key, target: true };
    if (nonCities.some((pattern) => pattern.test(foldText(row.city)))) return null;
    let city = otherCities.get(row.city);
    if (city === undefined) {
      city = otherCity(row, config.market);
      otherCities.set(row.city, city);
    }
    return city === null ? null : { key: city, target: false };
  };

  for (const row of rows) {
    const tuple = JSON.stringify([row.city, row.label, row.countryCode]);
    let placement = placements.get(tuple);
    if (placement === undefined) {
      placement = place(row);
      placements.set(tuple, placement);
    }
    if (placement === null) continue;
    const { key, target } = placement;
    const id = foldText(key);
    const group = groups.get(id) ?? { key, target, jobs: new Set<number>(), members: new Set<string>(), spellings: new Map<string, number>() };
    group.jobs.add(row.jobId);
    group.members.add(row.city);
    group.spellings.set(key, (group.spellings.get(key) ?? 0) + 1);
    groups.set(id, group);
  }

  const toGroup = (group: (typeof groups extends Map<string, infer V> ? V : never)): CityGroup => ({
    // a target keeps the spelling of the config; any other group the spelling most rows agree on
    key: group.target ? group.key : ([...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? group.key),
    target: group.target,
    jobCount: group.jobs.size,
    members: [...group.members].sort((a, b) => a.localeCompare(b)),
  });
  const all = [...groups.values()].map(toGroup);
  const targetOrder = new Map(targets.map((t, index) => [foldText(t.key), index]));
  const first = all.filter((g) => g.target).sort((a, b) => (targetOrder.get(foldText(a.key)) ?? 0) - (targetOrder.get(foldText(b.key)) ?? 0));
  const rest = all.filter((g) => !g.target).sort((a, b) => b.jobCount - a.jobCount || a.key.localeCompare(b.key));
  return [...first, ...rest];
}

/** The raw `locations_json[].city` values behind a dropdown value: the group's members, or the value itself when it names no group. */
export function cityMembers(groups: readonly CityGroup[], city: string): string[] {
  const wanted = foldText(city);
  const group = groups.find((g) => foldText(g.key) === wanted);
  return group ? group.members : [city];
}
