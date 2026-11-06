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

describe("every caller reads Munich and München as one city", () => {
  it.each([["Munich", "München, Germany"], ["München", "Munich, Germany"], ["Muenchen", "München, Germany"]])("the filter: wanted %s, job in %s", (wanted, label) => {
    const filter = filterWith(prefs((raw) => void (raw.locations = [wanted])), pipeline);
    const verdict = evaluateJob({ title: "Engineer", description: null, companyName: "Acme", companyNameNorm: "acme", companyAliases: [], companyBlacklisted: false, companyWatched: false, locations: [normalizeLocation(label, market)], workplace: "onsite", seniority: "unknown", contract: "unknown", salary: null, germanLevel: "unknown" }, filter);
    expect(verdict.reasons.filter((reason) => reason.startsWith("location_not_allowed"))).toEqual([]);
  });

  it("the filter still refuses another city", () => {
    const filter = filterWith(prefs((raw) => void (raw.locations = ["Munich"])), pipeline);
    const verdict = evaluateJob({ title: "Engineer", description: null, companyName: "Acme", companyNameNorm: "acme", companyAliases: [], companyBlacklisted: false, companyWatched: false, locations: [normalizeLocation("Hamburg, Germany", market)], workplace: "onsite", seniority: "unknown", contract: "unknown", salary: null, germanLevel: "unknown" }, filter);
    expect(verdict.reasons.some((reason) => reason.startsWith("location_not_allowed"))).toBe(true);
  });

  it("the apply target", () => {
    const names = targetPlaceNames({ locations: ["Munich"] }, pipeline).map((name) => name.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(["münchen", "munich"]));
  });

  it("the handpicked channel", () => {
    const places = buildPlaces({ locations: ["Munich"], geo: placeGeo(pipeline), remoteScope: "none", country: "DE" });
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
});
