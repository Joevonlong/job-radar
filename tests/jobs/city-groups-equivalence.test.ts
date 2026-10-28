import { describe, expect, it } from "vitest";

import { foldText, foldTransliterated, wholeWordPattern } from "@/lib/filter/rules";
import { buildCityGroups, type CityGroup, type CityGroupConfig, type CityRow } from "@/lib/jobs/city-groups";
import type { Market } from "@/lib/market/types";
import { normalizeDraftLocations, normalizeLocation, type DraftLocation } from "@/lib/pipeline/geography";

import { shippedPipeline } from "../pipeline/helpers";

/*
 * `buildCityGroups` places each distinct (city, label, country code) once. The oracle below is the
 * algorithm as it was before, placing every row on its own; on realistic inputs both must give the
 * same groups, in the same order, with the same members and counts.
 */

// ------------------------------------------------------------------ oracle: the per-row algorithm

interface Target {
  key: string;
  patterns: RegExp[];
}

/** A location with no country, or the home country: the only places a target city (or its metro area) can be. */
const inHomeOrUnstated = (row: Pick<CityRow, "countryCode">, market: Pick<Market, "country">): boolean => row.countryCode === null || row.countryCode === market.country;

function compileTargets(config: CityGroupConfig): Target[] {
  const canonicalOf = new Map<string, string>();
  const spellingsOf = new Map<string, string[]>();
  for (const [canonical, aliases] of Object.entries(config.filter.city_aliases)) {
    spellingsOf.set(canonical, [canonical, ...aliases]);
    for (const name of [canonical, ...aliases]) canonicalOf.set(foldText(name), canonical);
  }
  const canonical = (name: string): string => canonicalOf.get(foldText(name)) ?? name;
  const spellings = (name: string): string[] => spellingsOf.get(canonical(name)) ?? [name];

  const targets: Target[] = [];
  for (const location of config.targets) {
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
    targets.push({ key, patterns: [...patterns.values()] });
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

/**
 * Group the stored locations by city. Target cities come first in the order of `config.targets` (only
 * those with jobs), then the others, most jobs first; regions and country-level values are left out.
 */
function oracleCityGroups(rows: readonly CityRow[], config: CityGroupConfig): CityGroup[] {
  const targets = compileTargets(config);
  const nonCities = compileNonCities(config);
  const groups = new Map<string, { key: string; target: boolean; jobs: Set<number>; members: Set<string>; spellings: Map<string, number> }>();

  for (const row of rows) {
    const text = [foldText(row.city), foldText(row.label)];
    const target = inHomeOrUnstated(row, config.market) ? targets.find((t) => text.some((value) => value !== "" && t.patterns.some((pattern) => pattern.test(value)))) : undefined;
    let key: string;
    if (target) {
      key = target.key;
    } else {
      if (nonCities.some((pattern) => pattern.test(foldText(row.city)))) continue;
      const city = otherCity(row, config.market);
      if (city === null) continue;
      key = city;
    }
    const id = foldText(key);
    const group = groups.get(id) ?? { key, target: target !== undefined, jobs: new Set<number>(), members: new Set<string>(), spellings: new Map<string, number>() };
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


// ------------------------------------------------------------------ realistic inputs

/** A small deterministic generator (mulberry32), so a failure can be replayed. */
function generator(seed: number) {
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  // a few places are very common, most are rare
  const skewed = <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(items.length * next() ** 2.2))] as T;
  return { next, pick, skewed };
}

const munichArea = ["Garching", "Unterföhring", "Ismaning", "Unterschleißheim", "Planegg", "Martinsried", "Ottobrunn", "Poing", "Aschheim", "Feldkirchen", "Neubiberg", "Haar"];
const berlinArea = ["Potsdam", "Schönefeld", "Teltow", "Hennigsdorf"];
const otherCities = ["Hamburg", "Frankfurt", "Köln", "Cologne", "Stuttgart", "Düsseldorf", "Leipzig", "Nürnberg", "Nuremberg", "Bremen", "Bonn", "Aachen", "Heidelberg", "Walldorf", "Bochum", "Regensburg", "Würzburg", "Erlangen"];
const smallTowns = Array.from({ length: 120 }, (_, i) => `${otherCities[i % otherCities.length] ?? "Ulm"} ${["Nord", "Süd", "am Main", "(Westf.)", "bei Ulm", "in Oberbayern"][i % 6] ?? ""}`.trim());
const abroad = ["Amsterdam, North Holland, Netherlands", "London, England, United Kingdom", "Zürich, Switzerland", "Vienna, Austria", "Dublin, Ireland", "New York, NY", "Austin, TX", "Remote - USA", "Haar, Netherlands"];
const noPlace = ["Germany", "Deutschland", "Remote", "Remote, Germany", "Home Office", "Bavaria", "Hybrid"];

/** One location as a channel delivers it (LinkedIn-style labels, ATS-style city + country, towns, abroad, no place). */
function draftLocation(g: ReturnType<typeof generator>): DraftLocation {
  const u = g.next();
  const country = (): string | null => (g.next() < 0.5 ? "DE" : null);
  if (u < 0.3) {
    const city = g.pick(["Munich", "München", "Muenchen"]);
    return g.next() < 0.5 ? { label: g.pick([`${city}, Bavaria, Germany`, `Greater ${city} Metropolitan Area`, `${city}, Germany`, city]), city: null, countryCode: null } : { label: city, city, countryCode: "DE" };
  }
  if (u < 0.4) {
    const town = g.skewed(munichArea);
    return { label: g.pick([`${town}, Bavaria, Germany`, `${town} bei München`, town]), city: g.next() < 0.5 ? town : null, countryCode: country() };
  }
  if (u < 0.62) return g.next() < 0.5 ? { label: g.pick(["Berlin, Berlin, Germany", "Berlin Metropolitan Area"]), city: null, countryCode: null } : { label: g.pick(["Berlin", "Berlin, DE"]), city: "Berlin", countryCode: "DE" };
  if (u < 0.66) return { label: `${g.skewed(berlinArea)}, Brandenburg, Germany`, city: null, countryCode: null };
  if (u < 0.8) {
    const city = g.skewed(otherCities);
    return { label: g.pick([`${city}, Germany`, `${city}, Hesse, Germany`, city]), city: g.next() < 0.5 ? city : null, countryCode: country() };
  }
  if (u < 0.88) {
    const town = g.skewed(smallTowns);
    return { label: g.pick([`${town}, Deutschland`, `${town}, Germany`]), city: g.next() < 0.4 ? town : null, countryCode: country() };
  }
  if (u < 0.94) return { label: g.pick(noPlace), city: g.next() < 0.3 ? g.pick(noPlace) : null, countryCode: country() };
  const place = g.skewed(abroad);
  // a channel that states the city but no country, or a wrong one: the same city value with another label or country
  return { label: place, city: g.next() < 0.3 ? (place.split(",")[0] ?? place) : null, countryCode: g.next() < 0.2 ? g.pick(["NL", "AT", "DE"]) : null };
}

/** The rows `listJobCityRows` would read for `jobs` postings (the stored, normalized locations that name a city). */
function cityRows(jobs: number, market: Market, seed: number): CityRow[] {
  const g = generator(seed);
  const rows: CityRow[] = [];
  for (let jobId = 1; jobId <= jobs; jobId++) {
    const count = g.next() < 0.85 ? 1 : 2 + Math.floor(g.next() * 4);
    for (const location of normalizeDraftLocations(Array.from({ length: count }, () => draftLocation(g)), market)) {
      const city = location.city?.trim() ?? "";
      if (city !== "") rows.push({ jobId, city, label: location.label, countryCode: location.countryCode });
    }
  }
  return rows;
}

describe("buildCityGroups places each distinct location once and gives the same groups as placing every row", () => {
  const pipeline = shippedPipeline();
  const base = { filter: pipeline.filter, market: pipeline.market };
  const configs: Array<[string, CityGroupConfig]> = [
    ["two target cities", { ...base, targets: ["Berlin", "München"] }],
    ["one target city given by an alias", { ...base, targets: ["Munich"] }],
    ["no target cities", { ...base, targets: [] }],
  ];

  for (const seed of [1, 7, 2024]) {
    const rows = cityRows(1500, pipeline.market, seed);
    for (const [name, config] of configs) {
      it(`${name}, seed ${seed}`, () => {
        const distinct = new Set(rows.map((r) => JSON.stringify([r.city, r.label, r.countryCode]))).size;
        // the inputs repeat places, as real postings do, so the memo is exercised
        expect(distinct).toBeLessThan(rows.length / 2);
        expect(buildCityGroups(rows, config)).toEqual(oracleCityGroups(rows, config));
      });
    }
  }

  it("keeps rows apart that share the city but not the label or the country", () => {
    const config = { ...base, targets: ["München"] };
    const rows: CityRow[] = [
      { jobId: 1, city: "Haar", label: "Haar", countryCode: "DE" },
      { jobId: 2, city: "Haar", label: "Haar", countryCode: "NL" },
      { jobId: 3, city: "Haar", label: "Haar", countryCode: null },
      { jobId: 4, city: "Bavaria", label: "Munich, Bavaria, Germany", countryCode: "DE" },
      { jobId: 5, city: "Bavaria", label: "Bavaria", countryCode: "DE" },
      { jobId: 6, city: "Feldkirchen", label: "Feldkirchen", countryCode: "AT" },
      { jobId: 7, city: "Feldkirchen", label: "Feldkirchen", countryCode: "DE" },
      { jobId: 8, city: "Haar", label: "Haar", countryCode: "NL" },
    ];
    const groups = buildCityGroups(rows, config);
    expect(groups).toEqual(oracleCityGroups(rows, config));
    expect(groups.find((g) => g.target)?.jobCount).toBe(4); // 1, 3, 4 and 7
    expect(groups.filter((g) => !g.target).map((g) => [g.key, g.jobCount])).toEqual([
      ["Haar", 2],
      ["Feldkirchen", 1],
    ]);
  });
});
