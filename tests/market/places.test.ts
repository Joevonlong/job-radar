// @vitest-environment node
import { describe, expect, it } from "vitest";

import { canonicalCity, citySpellings, lookupPlace, type Place, type PlaceGeo } from "@/lib/market/places";

const geo: PlaceGeo = {
  cityAliases: { Cologne: ["Koeln"], Bigtown: ["Big Town"] },
  cities: { munich: ["München", "DE"], "münchen": ["München", "DE"], "köln": ["Köln", "DE"], cologne: ["Köln", "DE"], amsterdam: ["Amsterdam", "NL"], singapore: ["Singapore", "SG"] },
  countries: [
    { code: "DE", name: "Germany", aliases: ["Deutschland"] },
    { code: "NL", name: "Netherlands", aliases: ["Holland"] },
    { code: "CH", name: "Switzerland", aliases: [] },
    { code: "SG", name: "Singapore", aliases: [] },
  ],
  regions: { eu: { name: "European Union", countries: ["DE", "NL"] } },
};

const must = (text: string): Place => {
  const place = lookupPlace(text, geo);
  if (place === null) throw new Error(`unknown ${text}`);
  return place;
};

describe("lookupPlace", () => {
  it.each([
    ["Worldwide", "worldwide", []],
    ["  WORLDWIDE ", "worldwide", []],
    ["eu", "region", ["DE", "NL"]],
    ["European Union", "region", ["DE", "NL"]],
    ["Germany", "country", ["DE"]],
    ["deutschland", "country", ["DE"]],
    ["CH", "country", ["CH"]],
    ["Munich", "city", ["DE"]],
    ["München", "city", ["DE"]],
    ["Muenchen", "city", ["DE"]],
    ["munchen", "city", ["DE"]],
    ["Amsterdam", "city", ["NL"]],
  ])("%s is a %s in %j", (text, kind, countries) => {
    expect(must(text)).toMatchObject({ kind, countries });
  });

  it("does not know a made-up name, and an empty text is nothing", () => {
    expect(lookupPlace("Atlantis", geo)).toBeNull();
    expect(lookupPlace("   ", geo)).toBeNull();
  });

  it("gives every spelling of a place one name and one search text", () => {
    for (const text of ["Munich", "münchen", "Muenchen"]) expect(must(text)).toMatchObject({ name: "München", searchName: "München" });
    expect(must("deutschland")).toMatchObject({ name: "Germany", searchName: "Germany", spellings: ["Germany", "Deutschland"] });
    expect(must("eu")).toMatchObject({ name: "European Union", searchName: "European Union" });
  });

  it("sets the token only when the text is itself a scope token", () => {
    expect(must("eu").token).toBe("eu");
    expect(must("CH").token).toBe("CH");
    expect(must("EU").token).toBeNull();
    expect(must("ch").token).toBeNull();
    expect(must("European Union").token).toBeNull();
    expect(must("Switzerland").token).toBeNull();
    expect(must("Munich").token).toBeNull();
    expect(must("Worldwide").token).toBeNull();
  });

  it("reads a name that is both a country and a city as the country", () => {
    expect(must("Singapore")).toMatchObject({ kind: "country", countries: ["SG"] });
  });

  it("merges the two city tables, keeping the name the aliases give", () => {
    const cologne = must("Köln");
    expect(cologne).toMatchObject({ kind: "city", name: "Cologne", countries: ["DE"] });
    expect(cologne.spellings).toEqual(expect.arrayContaining(["Cologne", "Koeln", "köln"]));
  });

  it("knows a city only the aliases list, without a country", () => {
    expect(must("Big Town")).toMatchObject({ kind: "city", name: "Bigtown", countries: [] });
  });
});

describe("city spellings", () => {
  it("are every spelling of a known city, and only the text itself for an unknown one", () => {
    expect(citySpellings("Munich", geo)).toEqual(expect.arrayContaining(["München", "munich"]));
    expect(citySpellings("Muenchen", geo)).toEqual(expect.arrayContaining(["München", "munich", "Muenchen"]));
    expect(citySpellings("Atlantis", geo)).toEqual(["Atlantis"]);
  });

  it("read a city first, so a name that is also a country keeps its city spellings", () => {
    expect(citySpellings("Singapore", geo)).toEqual(expect.arrayContaining(["Singapore"]));
    expect(canonicalCity("Singapore", geo)).toBe("Singapore");
    expect(citySpellings("Deutschland", geo)).toEqual(["Deutschland"]);
  });

  it("give the table's name, or the text as written", () => {
    expect(canonicalCity("Munich", geo)).toBe("München");
    expect(canonicalCity("Atlantis", geo)).toBe("Atlantis");
  });
});
