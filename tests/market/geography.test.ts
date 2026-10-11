// @vitest-environment node
/** The location rules with the world country table (generic pack) and the home country of the market. */
import { describe, expect, it } from "vitest";

import { normalizeDraftLocations, normalizeLocation } from "@/lib/pipeline/geography";

import { editedPack, fixtureMarket } from "../pipeline/helpers";

const de = fixtureMarket();
const us = fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" });
const place = (label: string, market = de) => {
  const l = normalizeLocation(label, market);
  return [l.city, l.countryCode];
};

describe("countries outside the city table", () => {
  it.each([
    ["Remote - USA", null, "US"],
    ["Remote, US", null, "US"],
    ["United States (Remote)", null, "US"],
    ["Dublin, CA", null, "US"],
    ["Rome, GA", null, "US"],
    ["Paris, Texas, USA", null, "US"],
    ["London, Ontario, Canada", null, "CA"],
    ["Bengaluru, Karnataka, India", null, "IN"],
    ["Tbilisi, Georgia", null, "GE"],
    ["Kyiv, Ukraine", null, "UA"],
    ["İstanbul, Türkiye", null, "TR"],
    ["Dubai", null, "AE"],
  ] as const)("%s -> %s / %s", (label, city, country) => {
    expect(place(label)).toEqual([city, country]);
  });

  it("names that are also US states, words or parts of other names are not read as the country", () => {
    expect(place("Atlanta, Georgia")).toEqual([null, null]); // Georgia the US state: no rule for the bare name
    expect(place("Atlanta, Georgia, United States")).toEqual([null, "US"]);
    expect(place("Jersey City, NJ")).toEqual([null, "US"]); // Jersey is never read from a text
    expect(place("Albuquerque, New Mexico")).toEqual([null, null]);
    expect(place("Port Moresby, Papua New Guinea")).toEqual([null, "PG"]);
    expect(place("Juba, South Sudan")).toEqual([null, "SS"]);
    expect(place("Build agents with us in Berlin.")).toEqual(["Berlin", "DE"]); // "us" the word, not the country
    expect(place("Jordan Peterson Lab")).toEqual([null, null]);
    expect(place("Amman, Jordan")).toEqual([null, "JO"]);
  });

  it("the country named last decides: a European country after a US state code wins", () => {
    expect(place("Milano, MI, Italia")).toEqual(["Milan", "IT"]);
    expect(place("Remote - USA or Germany")).toEqual([null, "DE"]);
    expect(place("Germany / USA")).toEqual([null, "US"]);
  });

  it("keeps the canonical city names of the table (they are part of the dedupe key)", () => {
    expect(place("Vienna, Austria")).toEqual(["Wien", "AT"]);
    expect(place("Zurich, Switzerland")).toEqual(["Zürich", "CH"]);
    expect(place("Munich")).toEqual(["München", "DE"]);
  });

  it("keeps a channel's stated city and country, fills the country from the label otherwise", () => {
    const [a, b] = normalizeDraftLocations(
      [
        { label: "Austin, TX", city: "Austin", countryCode: null },
        { label: "Toronto, ON, Canada", city: null, countryCode: "CA" },
      ],
      de,
    );
    expect(a).toMatchObject({ city: "Austin", countryCode: "US" });
    expect(b).toMatchObject({ city: null, countryCode: "CA" });
  });
});

describe("the home country", () => {
  it("reads the city before the home country's name only in the home market, in its letter case", () => {
    expect(place("Gütersloh, Germany")).toEqual(["Gütersloh", "DE"]);
    expect(place("Gütersloh, Germany", us)).toEqual([null, "DE"]);
    expect(place("boise, united states", us)).toEqual(["Boise", "US"]);
    expect(place("boise, united states")).toEqual([null, "US"]);
  });

  it("with resolve_world_countries off a country outside the city table gives no country (before the market packs)", () => {
    const { market } = editedPack("generic", (pack) => void (pack.geography.resolve_world_countries = false));
    expect(place("Remote - USA", market)).toEqual([null, null]);
    expect(place("Berlin, Germany", market)).toEqual(["Berlin", "DE"]);
  });
});
