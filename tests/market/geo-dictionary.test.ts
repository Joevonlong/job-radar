// @vitest-environment node
/** The place dictionary's lookups, on a small hand-made file (the shipped file has its own smoke test). */
import { describe, expect, it } from "vitest";

import { createPlaceDictionary, createPlaceSource, placeDictionaryFileSchema, placeKey, placeLang, type PlaceDictionaryFile } from "@/lib/market/geo";

const fixture: PlaceDictionaryFile = {
  format: 1,
  source: "test fixture",
  licence: "CC BY 4.0",
  fetched: "2000-01-01",
  lastModified: {},
  counts: { places: 6, countries: 3, admin1: 4, placesWithZh: 2 },
  admin1: [
    ["AA.01", "North Province", "Nordprovinz", "北省"],
    ["AA.02", "South Province", null, null],
    ["BB.01", "Lake State", null, "湖州"],
    ["CC.05", "Hill County", null, null],
  ],
  countries: [
    ["AA", 100, "Alphaland", "Alphastaat", "阿尔法国", "Alfaland", "aa", 5_000_000, ["Republic of Alphaland"]],
    ["BB", 200, "Betania", null, null, null, "bb", 3_000_000, []],
    ["CC", 300, "Gammaria", null, "伽马国", null, "cc", 1_000_000, []],
  ],
  places: [
    [1001, "Stadtbach", null, "AA", "AA.01", 900_000, "Brookton", "Stadtbach", "溪城", "Stádtbach", ["Stadt-Bach"]],
    [1002, "Brookton", null, "BB", "BB.01", 120_000, null, null, null, null, []],
    [1003, "Brookton", null, "CC", "CC.05", 40_000, null, null, null, null, []],
    [1004, "Au", null, "AA", "AA.02", 20_000, null, null, null, null, []],
    [1005, "Aue", null, "AA", "AA.02", 18_000, null, null, null, null, []],
    [1006, "Ærøby", "AEroby", "AA", null, 16_000, null, null, "埃勒比", null, []],
  ],
};

const dictionary = createPlaceDictionary(placeDictionaryFileSchema.parse(fixture));

describe("placeKey", () => {
  it("ignores case, accents and word separators, and folds letters without a decomposition", () => {
    expect(placeKey("  Stádt-Bach ")).toBe("stadt bach");
    expect(placeKey("Straße")).toBe("strasse");
    expect(placeKey("Ærøby")).toBe("aeroby");
    expect(placeKey("St. Gallen")).toBe(placeKey("St Gallen"));
    expect(placeKey("溪城")).toBe("溪城");
  });
});

describe("matchPlaceName", () => {
  it("finds one place from any of its spellings", () => {
    const ids = ["溪城", "Stadtbach", "STADTBACH", "Stádtbach", "Stadt-Bach", "stadt bach"].map((name) =>
      dictionary.matchPlaceName(name).map((p) => p.id),
    );
    for (const found of ids) expect(found).toContain(1001);
  });

  it("returns every place sharing a name, the most populous first", () => {
    expect(dictionary.matchPlaceName("Brookton").map((p) => [p.id, p.countryCode])).toEqual([
      [1001, "AA"],
      [1002, "BB"],
      [1003, "CC"],
    ]);
    expect(dictionary.matchPlaceName("Brookton", { country: "cc" }).map((p) => p.id)).toEqual([1003]);
  });

  it("keeps names that only share a prefix apart", () => {
    expect(dictionary.matchPlaceName("Au").map((p) => p.id)).toEqual([1004]);
    expect(dictionary.matchPlaceName("Aue").map((p) => p.id)).toEqual([1005]);
  });

  it("finds countries by any of their names and can be limited to a kind", () => {
    expect(dictionary.matchPlaceName("阿尔法国").map((p) => [p.id, p.kind])).toEqual([[100, "country"]]);
    expect(dictionary.matchPlaceName("Republic of Alphaland")[0]?.id).toBe(100);
    expect(dictionary.matchPlaceName("Alphaland", { kinds: ["city"] })).toEqual([]);
  });

  it("finds nothing for an unknown or empty name", () => {
    expect(dictionary.matchPlaceName("Nowhere")).toEqual([]);
    expect(dictionary.matchPlaceName("  ")).toEqual([]);
  });
});

describe("searchPlaces", () => {
  it("matches a prefix in Latin or CJK script", () => {
    expect(dictionary.searchPlaces("Stad").map((p) => p.id)).toEqual([1001]);
    expect(dictionary.searchPlaces("溪").map((p) => p.id)).toEqual([1001]);
    expect(dictionary.searchPlaces("aero").map((p) => p.id)).toEqual([1006]);
  });

  it("ranks an exact name first, then by population", () => {
    expect(dictionary.searchPlaces("Au").map((p) => p.id)).toEqual([1004, 1005]);
    expect(dictionary.searchPlaces("Bro").map((p) => p.id)).toEqual([1001, 1002, 1003]);
  });

  it("ranks a place whose spelling has the typed accents above one that only matches without them", () => {
    const local = createPlaceDictionary({
      ...fixture,
      places: [
        [2001, "Munro", null, "AA", null, 500_000, null, null, null, null, []],
        [2002, "Münzdorf", null, "AA", null, 30_000, null, null, null, null, []],
      ],
    });
    expect(local.searchPlaces("Mün").map((p) => p.id)).toEqual([2002, 2001]);
    expect(local.searchPlaces("Mun").map((p) => p.id)).toEqual([2001, 2002]);
  });

  it("ranks places whose own name starts with the text above a larger place that only has another spelling starting so", () => {
    const local = createPlaceDictionary({
      ...fixture,
      places: [
        [2101, "Prishtina", null, "AA", null, 900_000, null, null, null, null, ["Aulona"]],
        [2102, "Auburg", null, "AA", null, 50_000, null, null, null, null, []],
        [2103, "Au", null, "AA", null, 1_000, null, null, null, null, []],
      ],
    });
    expect(local.searchPlaces("Au").map((p) => p.id)).toEqual([2103, 2102, 2101]);
  });

  it("honours limit, country and kind", () => {
    expect(dictionary.searchPlaces("Bro", { limit: 2 })).toHaveLength(2);
    expect(dictionary.searchPlaces("Bro", { country: "BB" }).map((p) => p.id)).toEqual([1002]);
    expect(dictionary.searchPlaces("Al", { kinds: ["country"] }).map((p) => p.id)).toEqual([100]);
    expect(dictionary.searchPlaces("")).toEqual([]);
    expect(dictionary.searchPlaces("Bro", { limit: 0 })).toEqual([]);
  });
});

describe("getPlace", () => {
  it("gives names, country and division in the requested language, English where one is missing", () => {
    expect(dictionary.getPlace(1001, "zh")).toEqual({
      id: 1001,
      kind: "city",
      name: "溪城",
      names: { en: "Brookton", de: "Stadtbach", zh: "溪城" },
      localName: "Stádtbach",
      searchName: "Stádtbach",
      countryCode: "AA",
      countryName: "阿尔法国",
      admin1: "北省",
      population: 900_000,
      spellings: ["Stadtbach", "Brookton", "溪城", "Stádtbach", "Stadt-Bach"],
    });
    const de = dictionary.getPlace(1002, "de");
    expect([de?.name, de?.countryName, de?.admin1, de?.searchName]).toEqual(["Brookton", "Betania", "Lake State", "Brookton"]);
    expect(dictionary.getPlace(1006, "en")?.spellings).toEqual(["Ærøby", "AEroby", "埃勒比"]);
    expect(dictionary.getPlace(1006, "en")?.admin1).toBeNull();
    expect(dictionary.getPlace(9999)).toBeNull();
  });
});

describe("getCountry", () => {
  it("gives a country by its code, in the requested language", () => {
    expect(dictionary.getCountry("aa", "zh")?.name).toBe("阿尔法国");
    expect(dictionary.getCountry("AA")?.id).toBe(100);
    expect(dictionary.getCountry("ZZ")).toBeNull();
  });
});

describe("createPlaceSource", () => {
  const brookton = dictionary.getPlace(1002, "en");
  const alphaland = dictionary.getCountry("AA", "en");
  const source = createPlaceSource([brookton, alphaland].filter((p) => p !== null));

  it("answers like the dictionary for the places it holds, and knows no other", () => {
    expect(source.getPlace(1002)?.countryCode).toBe("BB");
    expect(source.getPlace(1001)).toBeNull();
    expect(source.getCountry("aa")?.id).toBe(100);
    expect(source.getCountry("BB")).toBeNull();
    expect(source.matchPlaceName("BROOKTON").map((p) => p.id)).toEqual([1002]);
    expect(source.matchPlaceName("Brookton", { kinds: ["country"] })).toEqual([]);
    expect(source.matchPlaceName("Alfaland").map((p) => p.id)).toEqual([100]);
  });
});

describe("placeLang", () => {
  it("names places in a page's language where the dictionary has it, else in English", () => {
    expect(placeLang("zh")).toBe("zh");
    expect(placeLang("zh-CN")).toBe("zh");
    expect(placeLang("de-AT")).toBe("de");
    expect(placeLang("fr")).toBe("en");
  });
});

describe("file format", () => {
  it("rejects a file of another format version or with malformed rows", () => {
    expect(placeDictionaryFileSchema.safeParse({ ...fixture, format: 2 }).success).toBe(false);
    expect(placeDictionaryFileSchema.safeParse({ ...fixture, places: [[1, "", null, "AA", null, 1, null, null, null, null, []]] }).success).toBe(false);
  });
});
