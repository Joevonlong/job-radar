// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildPlaces, matchesPlace } from "@/lib/channels/handpicked/select";
import { targetPlaceNames } from "@/lib/dashboard/apply";
import { evaluateJob } from "@/lib/filter";
import { buildCityGroups } from "@/lib/jobs/city-groups";
import { placeGeo } from "@/lib/market/places";
import { normalizeLocation } from "@/lib/pipeline/geography";

import { prefs, filterWith } from "../filter/helpers";
import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

// The generic market has no city aliases of its own for these: the spellings come from the city table alone
const market = fixtureMarket({ pack: "generic", country: "DE", currency: "EUR", home_language: "de" });
const pipeline = { ...shippedPipeline(market), filter: { ...shippedPipeline(market).filter, city_aliases: {} } };

describe("a place to move to counts abroad", () => {
  const abroad = { ...pipeline, market: { ...pipeline.market, cities: { ...pipeline.market.cities, amsterdam: ["Amsterdam", "NL"] as [string, string] } } };

  it("in the city groups, a city is listed and a whole country is not", () => {
    const groups = buildCityGroups(
      [{ jobId: 1, city: "Amsterdam", label: "Amsterdam, Netherlands", countryCode: "NL" }, { jobId: 3, city: "Utrecht", label: "Utrecht, Netherlands", countryCode: "NL" }],
      { targets: ["Amsterdam", "NL"], filter: abroad.filter, market: { ...market, cities: abroad.market.cities } },
    );
    const target = groups.filter((group) => group.target);
    expect(target.map((group) => group.key)).toEqual(["Amsterdam"]);
    expect(target[0]?.jobCount).toBe(1);
  });
});

describe("the handpicked channel without a home city, or with a whole country", () => {
  const abroad = { ...pipeline, market: { ...pipeline.market, cities: { ...pipeline.market.cities, amsterdam: ["Amsterdam", "NL"] as [string, string] } } };
  const onsite = (slug: string) => ({ cities: [slug], remoteType: "onsite" as const, remoteCountryCodes: [] });
  const places = (home_city: string, list: { place: string; relocate: boolean }[]) => buildPlaces({ preferences: { home_city, places: list, workplace: ["onsite"] }, geo: placeGeo(abroad, null), country: "DE" });

  it("keeps a city of the home country when there is no home city", () => {
    expect(matchesPlace(onsite("München"), places("", []))).toBe(true);
    expect(matchesPlace(onsite("Amsterdam"), places("", []))).toBe(false);
    expect(matchesPlace(onsite("München"), places("Berlin", []))).toBe(false);
  });

  it("keeps a city of a country to move to, not of a remote-only one", () => {
    expect(matchesPlace(onsite("Amsterdam"), places("Berlin", [{ place: "NL", relocate: true }]))).toBe(true);
    expect(matchesPlace(onsite("Amsterdam"), places("Berlin", [{ place: "NL", relocate: false }]))).toBe(false);
  });
});

describe("the city groups keep the home city in the home country", () => {
  it("even when the tables do not know it", () => {
    const target = (countryCode: string | null) => buildCityGroups([{ jobId: 1, city: "Poing", label: "Poing", countryCode }], { targets: ["Poing"], homeCity: "Poing", filter: pipeline.filter, market })[0]?.target;
    expect(target("AT")).toBe(false);
    expect(target(null)).toBe(true);
    expect(target("DE")).toBe(true);
  });
});

describe("every caller reads Munich and München as one city", () => {
  it.each([["Munich", "München, Germany"], ["München", "Munich, Germany"], ["Muenchen", "München, Germany"]])("the filter: wanted %s, job in %s", (wanted, label) => {
    const filter = filterWith(prefs((raw) => void (raw.home_city = wanted)), pipeline);
    const verdict = evaluateJob({ title: "Engineer", description: null, companyName: "Acme", companyNameNorm: "acme", companyAliases: [], companyBlacklisted: false, companyWatched: false, locations: [normalizeLocation(label, market)], workplace: "onsite", seniority: "unknown", contract: "unknown", salary: null, germanLevel: "unknown" }, filter);
    expect(verdict.reasons.filter((reason) => reason.startsWith("location_not_allowed"))).toEqual([]);
  });

  it("the filter still refuses another city", () => {
    const filter = filterWith(prefs((raw) => void (raw.home_city = "Munich")), pipeline);
    const verdict = evaluateJob({ title: "Engineer", description: null, companyName: "Acme", companyNameNorm: "acme", companyAliases: [], companyBlacklisted: false, companyWatched: false, locations: [normalizeLocation("Hamburg, Germany", market)], workplace: "onsite", seniority: "unknown", contract: "unknown", salary: null, germanLevel: "unknown" }, filter);
    expect(verdict.reasons.some((reason) => reason.startsWith("location_not_allowed"))).toBe(true);
  });

  it("the apply target", () => {
    const names = targetPlaceNames({ home_city: "Munich", places: [] }, pipeline).map((name) => name.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(["münchen", "munich"]));
  });

  it("the handpicked channel", () => {
    const places = buildPlaces({ preferences: { home_city: "Munich", places: [], workplace: ["onsite"] }, geo: placeGeo(pipeline, null), country: "DE" });
    expect(matchesPlace({ cities: ["München"], remoteType: "onsite", remoteCountryCodes: [] }, places)).toBe(true);
    expect(matchesPlace({ cities: ["Hamburg"], remoteType: "onsite", remoteCountryCodes: [] }, places)).toBe(false);
  });

  it("the city groups", () => {
    const groups = buildCityGroups(
      [{ jobId: 1, city: "München", label: "München, Germany", countryCode: "DE" }, { jobId: 2, city: "Munich", label: "Munich", countryCode: null }],
      { targets: ["Munich"], filter: pipeline.filter, market },
    );
    const target = groups.filter((group) => group.target);
    expect(target).toHaveLength(1);
    expect(target[0]?.key).toBe("München");
  });

  const hannoverJob = (label: string) => ({ title: "Engineer", description: null, companyName: "Acme", companyNameNorm: "acme", companyAliases: [], companyBlacklisted: false, companyWatched: false, locations: [normalizeLocation(label, market)], workplace: "onsite" as const, seniority: "unknown" as const, contract: "unknown" as const, salary: null, germanLevel: "unknown" as const });
  const withAliases = (cityAliases: Record<string, string[]>) => ({ ...pipeline, market: { ...pipeline.market, cities: { hannover: ["Hannover", "DE"], hanover: ["Hannover", "DE"], au: ["Au", "CH"], aue: ["Aue", "DE"] } as typeof pipeline.market.cities }, filter: { ...pipeline.filter, city_aliases: cityAliases } });

  it("the filter: a custom alias for one spelling does not drop the market's other spelling", () => {
    const filter = filterWith(prefs((raw) => void (raw.home_city = "Hanover")), withAliases({ Hanover: ["Hannover City"] }));
    const verdict = evaluateJob(hannoverJob("Hannover, Germany"), filter);
    expect(verdict.reasons.some((reason) => reason.startsWith("location_not_allowed"))).toBe(false);
  });

  it("the filter: an Aue preference does not admit a job in Au", () => {
    const filter = filterWith(prefs((raw) => void (raw.home_city = "Aue")), withAliases({}));
    expect(evaluateJob(hannoverJob("Aue, Germany"), filter).reasons.some((reason) => reason.startsWith("location_not_allowed"))).toBe(false);
    expect(evaluateJob(hannoverJob("Au, Switzerland"), filter).reasons.some((reason) => reason.startsWith("location_not_allowed"))).toBe(true);
  });
});
