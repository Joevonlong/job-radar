// @vitest-environment node
/** Smoke test on the generated place dictionary that ships with the product (config/geo/places.json.gz). */
import { beforeAll, describe, expect, it } from "vitest";

import { matchPlaceName, placeDictionary, resetPlaceDictionaryCache, searchPlaces } from "@/lib/market/geo";

beforeAll(() => {
  resetPlaceDictionaryCache();
});

describe("shipped place dictionary", () => {
  it("loads, carries its source and licence, and holds cities and countries", () => {
    const { meta } = placeDictionary();
    expect(meta.source).toContain("GeoNames");
    expect(meta.licence).toContain("CC BY 4.0");
    expect(meta.counts.places).toBeGreaterThan(20_000);
    expect(meta.counts.countries).toBeGreaterThan(200);
  });

  it("finds one place from its Chinese, Spanish, German and English spelling", () => {
    const ids = ["慕尼黑", "Múnich", "München", "Munich"].map((name) => matchPlaceName(name, { kinds: ["city"] }).map((p) => p.id));
    const first = ids[0]?.[0];
    expect(first).toBeDefined();
    for (const found of ids) expect(found).toEqual([first]);
    const place = matchPlaceName("Munich", { lang: "zh" })[0];
    expect([place?.name, place?.countryCode, place?.searchName]).toEqual(["慕尼黑", "DE", "München"]);
  });

  it("keeps places that share a name apart", () => {
    const countries = matchPlaceName("Cambridge", { kinds: ["city"] }).map((p) => p.countryCode);
    expect(countries).toEqual(expect.arrayContaining(["GB", "US"]));
    const us = matchPlaceName("Cambridge", { country: "US" })[0];
    expect(us?.admin1).toBe("Massachusetts");
  });

  it("completes Latin and Chinese prefixes", () => {
    const munich = matchPlaceName("München")[0]?.id;
    expect(searchPlaces("Mün", { lang: "de", limit: 5 }).map((p) => p.id)).toContain(munich);
    expect(searchPlaces("慕尼", { lang: "zh", limit: 5 })[0]?.id).toBe(munich);
  });

  it("completes Au with places named so, not with one that only has an alias starting so", () => {
    const names = searchPlaces("Au", { limit: 5 }).map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(expect.arrayContaining(["Australia", "Austria"]));
    expect(names).not.toContain("Kosovo");
  });

  it("does not take one place for another that only shares a prefix", () => {
    const aue = matchPlaceName("Aue", { country: "DE" });
    expect(aue).toHaveLength(1);
    expect(matchPlaceName("Au").map((p) => p.id)).not.toContain(aue[0]?.id);
  });
});
