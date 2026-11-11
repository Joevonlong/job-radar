// @vitest-environment node
/** `lookupPlace` with the place dictionary behind the market's tables: ids, shared names, saving and old files. */
import { describe, expect, it } from "vitest";

import { createPlaceDictionary, createPlaceSource, placeDictionaryFileSchema, type PlaceDictionaryFile } from "@/lib/market/geo";
import { homeCityAbroad, lookupPlace, normalizePlaces, placeCandidate, resolvePlaces, samePlaceKey, storedPlaceName, unknownPlaces, type PlaceGeo } from "@/lib/market/places";

const file: PlaceDictionaryFile = {
  format: 1,
  source: "test fixture",
  licence: "CC BY 4.0",
  fetched: "2000-01-01",
  lastModified: {},
  counts: { places: 4, countries: 2, admin1: 2, placesWithZh: 1 },
  admin1: [
    ["XA.01", "North Province", null, "北省"],
    ["YB.02", "Lake State", null, null],
  ],
  countries: [
    ["XA", 100, "Xaland", "Xaland", "叉国", null, "xa", 5_000_000, []],
    ["YB", 200, "Ybaria", null, null, null, "yb", 3_000_000, []],
  ],
  places: [
    [1001, "Bigtown", null, "XA", "XA.01", 900_000, null, "Großstadt", "大城", null, []],
    [1002, "Cambridge", null, "XA", "XA.01", 120_000, null, null, null, null, []],
    [1003, "Cambridge", null, "YB", "YB.02", 110_000, null, null, null, null, []],
    [1004, "Tinyville", null, "YB", "YB.02", 16_000, null, null, null, null, []],
  ],
};

const dictionary = createPlaceDictionary(placeDictionaryFileSchema.parse(file));
const tables: PlaceGeo = {
  cityAliases: {},
  cities: { bigtown: ["Bigtown", "XA"] },
  countries: [{ code: "XA", name: "Xaland", aliases: [] }],
  regions: { north: { name: "Northlands", countries: ["XA"] } },
};
const geo: PlaceGeo = { ...tables, dictionary };

describe("lookupPlace with the dictionary", () => {
  it("finds a city only the dictionary knows, in any of its spellings, with its id", () => {
    expect(lookupPlace("Tinyville", tables)).toBeNull();
    expect(lookupPlace("tinyville", geo)).toMatchObject({ kind: "city", name: "Tinyville", countries: ["YB"], id: 1004 });
  });

  it("keeps the tables' name for a city they know, and adds the dictionary's spellings and id", () => {
    const place = lookupPlace("大城", geo);
    expect(place).toMatchObject({ kind: "city", name: "Bigtown", id: 1001 });
    expect(place?.spellings).toEqual(expect.arrayContaining(["Bigtown", "Großstadt", "大城"]));
  });

  it("gives Worldwide, a region and a country their ids", () => {
    expect(lookupPlace("Worldwide", geo)?.id).toBe("worldwide");
    expect(lookupPlace("Northlands", geo)?.id).toBe("north");
    expect(lookupPlace("Xaland", geo)?.id).toBe(100);
    expect(lookupPlace("Ybaria", geo)).toMatchObject({ kind: "country", countries: ["YB"], id: 200 });
  });

  it("reads a shared name as the largest place, and an id as the place it names", () => {
    expect(lookupPlace("Cambridge", geo)?.countries).toEqual(["XA"]);
    expect(lookupPlace("Cambridge", geo, 1003)?.countries).toEqual(["YB"]);
    expect(samePlaceKey("Cambridge", geo, 1002)).not.toBe(samePlaceKey("Cambridge", geo, 1003));
  });

  it("stores a country by its code and a city by its name", () => {
    expect(storedPlaceName("Ybaria", geo)).toBe("YB");
    expect(storedPlaceName("Großstadt", geo)).toBe("Bigtown");
  });

  it("reads the same in the browser from the records a page holds", () => {
    const records = [dictionary.getPlace(1003, "zh"), dictionary.getPlace(1001, "zh")].filter((p) => p !== null);
    const browser: PlaceGeo = { ...tables, dictionary: createPlaceSource(records) };
    expect(lookupPlace("Cambridge", browser, 1003)?.countries).toEqual(["YB"]);
    expect(lookupPlace("大城", browser)?.id).toBe(1001);
    expect(lookupPlace("Tinyville", browser)).toBeNull();
  });
});

describe("placeCandidate", () => {
  it("names a place in the page's language, with its division and country, and saves its stored name and id", () => {
    const zh = dictionary.getPlace(1001, "zh");
    if (zh === null) throw new Error("fixture");
    expect(placeCandidate(zh, geo)).toMatchObject({ id: 1001, kind: "city", place: "Bigtown", label: "大城", detail: "北省, 叉国" });
    const country = dictionary.getCountry("YB");
    if (country === null) throw new Error("fixture");
    expect(placeCandidate(country, geo)).toMatchObject({ id: 200, kind: "country", place: "YB", detail: "" });
  });
});

describe("unknownPlaces", () => {
  it("lists the names nothing knows, the home city first", () => {
    const preferences = { home_city: "Atlantis", places: [{ place: "Tinyville", relocate: true }, { place: "El Dorado", relocate: false }] };
    expect(unknownPlaces(preferences, geo)).toEqual(["Atlantis", "El Dorado"]);
    expect(unknownPlaces({ home_city: "", places: [] }, geo)).toEqual([]);
  });
});

describe("resolvePlaces", () => {
  it("adds each known place's id and keeps a text that is one of its spellings", () => {
    const out = resolvePlaces({ home_city: "Großstadt", places: [{ place: "tinyville", relocate: true }, { place: "Northlands", relocate: false }] }, geo, false);
    expect(out).toEqual({ home_city: "Großstadt", home_city_id: 1001, places: [{ place: "tinyville", relocate: true, id: 1004 }, { place: "Northlands", relocate: false, id: "north" }] });
  });

  it("renames every known place to its stored name when asked (the wizard, the command line, an answers file)", () => {
    const out = resolvePlaces({ home_city: "大城", places: [{ place: "ybaria", relocate: false }] }, geo, true);
    expect(out).toEqual({ home_city: "Bigtown", home_city_id: 1001, places: [{ place: "YB", relocate: false, id: 200 }] });
  });

  it("keeps the place an id names, and an unknown name as written without an id", () => {
    const out = resolvePlaces({ home_city: "", home_city_id: 1001, places: [{ place: "Cambridge", relocate: true, id: 1003 }, { place: " Atlantis ", relocate: true }] }, geo, false);
    expect(out).toEqual({ home_city: "", places: [{ place: "Cambridge", relocate: true, id: 1003 }, { place: "Atlantis", relocate: true }] });
  });
});

describe("ids in the location settings", () => {
  it("keeps two places of one name apart by their ids, and one place named twice once", () => {
    const two = normalizePlaces({ home_city: "", places: [{ place: "Cambridge", relocate: true, id: 1002 }, { place: "Cambridge", relocate: false, id: 1003 }] }, geo);
    expect(two.places).toHaveLength(2);
    const one = normalizePlaces({ home_city: "", places: [{ place: "Xaland", relocate: false, id: 100 }, { place: "XA", relocate: true }] }, geo);
    expect(one.places).toEqual([{ place: "Xaland", relocate: true, id: 100 }]);
  });

  it("drops a place that is the home city by id", () => {
    const out = normalizePlaces({ home_city: "Cambridge", home_city_id: 1003, places: [{ place: "Cambridge", relocate: true, id: 1003 }, { place: "Cambridge", relocate: true, id: 1002 }] }, geo);
    expect(out.places).toEqual([{ place: "Cambridge", relocate: true, id: 1002 }]);
  });

  it("finds the home city abroad by its id", () => {
    expect(homeCityAbroad("Cambridge", geo, "XA", 1002)).toBeNull();
    expect(homeCityAbroad("Cambridge", geo, "XA", 1003)).toEqual({ code: "YB", name: "YB" });
  });
});
