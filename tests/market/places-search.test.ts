// @vitest-environment node
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

import { buildQueries, onsiteSearchTexts, queryId } from "@/lib/channels/query";
import { preferences003 } from "@/lib/config/migrations/preferences/003-places";
import type { SearchConfig } from "@/lib/config";
import { placeAreas, placesBeyondSearchEntries, plannedSearches, searchEntriesOutsidePlaces, wantedCities, wantedLocations, wantedRemoteScope, type PlaceGeo } from "@/lib/market/places";

import { shippedSearch } from "../channels/helpers";

const geo: PlaceGeo = {
  cityAliases: { Aliastown: ["Alias Town"] },
  cities: { berlin: ["Berlin", "XA"], hamburg: ["Hamburg", "XA"], amsterdam: ["Amsterdam", "NL"], paris: ["Paris", "FR"] },
  countries: [
    { code: "XA", name: "Xaland", aliases: [] },
    { code: "NL", name: "Netherlands", aliases: ["Holland"] },
    { code: "FR", name: "France", aliases: [] },
    { code: "CH", name: "Switzerland", aliases: [] },
  ],
  regions: { eu: { name: "European Union", countries: ["XA", "NL", "FR"] } },
};
const home = { country: "XA", countryName: "Xaland" };
const all = ["onsite", "hybrid", "remote"];
const moving = (place: string) => ({ place, relocate: true });
const remoteOnly = (place: string) => ({ place, relocate: false });
const plan = (home_city: string, places: { place: string; relocate: boolean }[], workplace = all) => plannedSearches({ home_city, places, workplace }, geo, home);
const brief = (searches: ReturnType<typeof plan>) => searches.map(({ location, remote, remoteScope, country }) => ({ location, remote, remoteScope, country }));

describe("plannedSearches", () => {
  it("searches the home city and places to move to on site, and home by remote", () => {
    expect(brief(plan("Berlin", [moving("Amsterdam")], ["onsite"]))).toEqual([
      { location: "Berlin", remote: false, remoteScope: null, country: "XA" },
      { location: "Amsterdam", remote: false, remoteScope: null, country: "NL" },
    ]);
    expect(brief(plan("Berlin", [])).at(-1)).toEqual({ location: null, remote: true, remoteScope: "home_country", country: "XA" });
  });

  it("searches the country's name on site without a home city", () => {
    expect(plan("", [], ["onsite"]).map((search) => search.location)).toEqual(["Xaland"]);
  });

  it("never searches a remote-only place on site", () => {
    expect(plan("Berlin", [remoteOnly("Amsterdam"), remoteOnly("NL")]).filter((search) => !search.remote).map((search) => search.location)).toEqual(["Berlin"]);
  });

  it("gives each kind of place the remote search of the table", () => {
    const remote = (text: string, relocate = false) => brief(plan("Berlin", [{ place: text, relocate }])).filter((search) => search.remote).at(-1);
    expect(remote("Worldwide")).toEqual({ location: null, remote: true, remoteScope: "worldwide", country: null });
    expect(remote("eu")).toEqual({ location: null, remote: true, remoteScope: { region: ["eu"] }, country: null });
    expect(remote("CH")).toEqual({ location: null, remote: true, remoteScope: { region: ["CH"] }, country: "CH" });
    expect(remote("Netherlands")).toEqual({ location: "Netherlands", remote: true, remoteScope: null, country: "NL" });
    expect(remote("Amsterdam")).toEqual({ location: "Amsterdam", remote: true, remoteScope: null, country: "NL" });
  });

  it("adds no remote search for a city in the home country, and none for a place to move to the tables do not know", () => {
    expect(plan("Berlin", [moving("Hamburg")]).filter((search) => search.remote)).toHaveLength(1);
    expect(plan("Berlin", [moving("Smalltown")]).filter((search) => search.remote)).toHaveLength(1);
  });

  it("searches an unknown or alias-only place without a country", () => {
    expect(plan("Berlin", [moving("Smalltown")]).find((search) => search.place === "Smalltown")?.country).toBeNull();
    expect(plan("Berlin", [moving("Aliastown")]).find((search) => search.place === "Aliastown")?.country).toBeNull();
    expect(brief(plan("Berlin", [remoteOnly("Smalltown")])).at(-1)).toEqual({ location: "Smalltown", remote: true, remoteScope: null, country: null });
  });

  it("searches a region to move to once on site, under its name", () => {
    const onsite = plan("Berlin", [moving("eu")]).filter((search) => search.place === "eu" && !search.remote);
    expect(onsite.map((search) => search.location)).toEqual(["European Union"]);
  });

  it("keeps the home remote search for a home country listed by name, and adds no other", () => {
    const remote = plan("Berlin", [moving("Xaland")]).filter((search) => search.remote);
    expect(brief(remote)).toEqual([{ location: null, remote: true, remoteScope: "home_country", country: "XA" }]);
  });

  it("drops the home remote search when a listed scope token or Worldwide covers home", () => {
    for (const covering of ["eu", "XA", "Worldwide"]) {
      expect(plan("Berlin", [remoteOnly(covering)]).some((search) => search.remoteScope === "home_country")).toBe(false);
    }
    expect(plan("Berlin", [remoteOnly("CH")]).some((search) => search.remoteScope === "home_country")).toBe(true);
    expect(plan("Berlin", [remoteOnly("Amsterdam")]).some((search) => search.remoteScope === "home_country")).toBe(true);
  });
});

describe("an upgraded config keeps its queries and ids", () => {
  const search: SearchConfig = { ...shippedSearch(), keyword_groups: { group: ["word"] } };
  const migrated = (locations: string[], scope: unknown, workplace = all) => {
    const doc = parseDocument(JSON.stringify({ target_titles: ["Engineer"], locations, remote_scope: scope, workplace }));
    preferences003.migrate(doc);
    return doc.toJS() as { home_city: string; places: { place: string; relocate: boolean }[]; workplace: string[] };
  };
  const ids = (locations: string[], scope: unknown, workplace = all) => buildQueries(search, { preferences: migrated(locations, scope, workplace), geo, home }, "manual").map((query) => query.id);
  const onsiteId = (location: string) => queryId({ keywords: ["word"], keywordGroup: "group", location, remote: false, remoteScope: null });
  const remoteId = (remoteScope: Parameters<typeof queryId>[0]["remoteScope"], location: string | null = null) => queryId({ keywords: ["word"], keywordGroup: "group", location, remote: true, remoteScope });

  it.each([
    ["home", ["Berlin", "Hamburg"], "home_country", [remoteId("home_country")]],
    ["worldwide", ["Berlin", "Hamburg"], "worldwide", [remoteId("worldwide")]],
    ["one token that covers home", ["Berlin", "Hamburg"], { region: ["eu"] }, [remoteId({ region: ["eu"] })]],
  ])("%s", (_name, locations, scope, remote) => {
    expect(ids(locations, scope)).toEqual([onsiteId("Berlin"), onsiteId("Hamburg"), ...remote]);
  });

  it("without remote work: on-site searches alone", () => {
    expect(ids(["Berlin"], "none", ["onsite", "hybrid"])).toEqual([onsiteId("Berlin")]);
  });

  it("a home country among the locations keeps the home search", () => {
    expect(ids(["Berlin", "Xaland"], "home_country")).toEqual([onsiteId("Berlin"), onsiteId("Xaland"), remoteId("home_country")]);
  });

  it("a scope that does not cover home adds the home search", () => {
    expect(ids(["Berlin"], { region: ["CH"] })).toEqual([onsiteId("Berlin"), remoteId("home_country"), remoteId({ region: ["CH"] })]);
  });

  it("several tokens split by token", () => {
    expect(ids(["Berlin"], { region: ["eu", "CH"] })).toEqual([onsiteId("Berlin"), remoteId({ region: ["eu"] }), remoteId({ region: ["CH"] })]);
  });

  it("none with only remote work adds the home search", () => {
    expect(ids(["Berlin"], "none", ["remote"])).toEqual([onsiteId("Berlin"), remoteId("home_country")]);
  });

  it("a foreign city adds its remote search", () => {
    expect(ids(["Berlin", "Amsterdam"], "home_country")).toEqual([onsiteId("Berlin"), onsiteId("Amsterdam"), remoteId("home_country"), remoteId(null, "Amsterdam")]);
  });
});

describe("placeAreas", () => {
  const areas = (home_city: string, places: { place: string; relocate: boolean }[]) => placeAreas({ home_city, places }, geo, "XA");

  it("widens the labels to the regions of a place abroad, not of home", () => {
    expect(areas("Berlin", []).wideRegions).toEqual([]);
    expect(areas("Berlin", [remoteOnly("Amsterdam")]).wideRegions).toEqual(["eu"]);
    expect(areas("Berlin", [remoteOnly("CH")]).wideRegions).toEqual([]);
  });

  it("gives a listed region only itself, and its countries to remote jobs", () => {
    const listed = areas("Berlin", [remoteOnly("eu")]);
    expect(listed.wideRegions).toEqual(["eu"]);
    expect([...listed.remoteCountries].sort()).toEqual(["FR", "NL", "XA"]);
    expect(listed.moveCountries.size).toBe(0);
  });

  it("moves to a whole country only when it is marked so", () => {
    expect([...areas("Berlin", [moving("NL")]).moveCountries]).toEqual(["NL"]);
    expect(areas("Berlin", [remoteOnly("NL")]).moveCountries.size).toBe(0);
  });
});

describe("old search.yaml entries", () => {
  const prefs = { home_city: "Berlin", places: [moving("Amsterdam"), remoteOnly("eu")] };

  it("are quiet when the location settings list them, in any spelling", () => {
    expect(searchEntriesOutsidePlaces({ locations: ["berlin", "Amsterdam"], remote_scope: { region: ["eu"] } }, prefs, geo)).toEqual([]);
    expect(searchEntriesOutsidePlaces({ remote_scope: "home_country" }, prefs, geo)).toEqual([]);
    expect(searchEntriesOutsidePlaces({}, prefs, geo)).toEqual([]);
  });

  it("are named when they are not listed", () => {
    expect(searchEntriesOutsidePlaces({ locations: ["Berlin", "Paris"], remote_scope: { region: ["CH", "eu"] } }, prefs, geo)).toEqual(["Paris", "CH"]);
    expect(searchEntriesOutsidePlaces({ remote_scope: "worldwide" }, prefs, geo)).toEqual(["Worldwide"]);
  });

  it("ignore a value of the wrong shape", () => {
    expect(searchEntriesOutsidePlaces({ locations: "Paris", remote_scope: 3 }, prefs, geo)).toEqual([]);
  });
});

describe("Worldwide marked as a place to move to", () => {
  const preferences = { home_city: "Berlin", places: [moving("Worldwide")], workplace: all };

  it("is read as remote only by the searches, the texts and the prompt's scope", () => {
    expect(plannedSearches(preferences, geo, home).filter((search) => !search.remote).map((search) => search.location)).toEqual(["Berlin"]);
    expect(wantedLocations(preferences)).toEqual(["Berlin"]);
    expect(wantedRemoteScope(preferences, geo)).toBe("worldwide");
  });
});

describe("wantedCities", () => {
  it("keeps the home city, cities and unknown names, and drops countries and regions", () => {
    const places = [moving("Amsterdam"), moving("NL"), moving("eu"), moving("Poing"), remoteOnly("Paris")];
    expect(wantedCities({ home_city: "Berlin", places }, geo)).toEqual(["Berlin", "Amsterdam", "Poing"]);
  });

  it("keeps a home city the tables call a country", () => {
    expect(wantedCities({ home_city: "Xaland", places: [] }, geo)).toEqual(["Xaland"]);
  });
});

describe("placeAreas of a place to move to", () => {
  it("adds home to a city's countries when it is marked so, and leaves an unknown name open", () => {
    const { named } = placeAreas({ home_city: "", places: [moving("Paris"), remoteOnly("Amsterdam"), moving("Poing")] }, geo, "XA");
    expect(named.map(({ text, countries }) => [text, countries])).toEqual([["Paris", ["FR", "XA"]], ["Amsterdam", ["NL"]], ["Poing", null]]);
  });
});

describe("onsiteSearchTexts", () => {
  it("names a place once, whatever its case", () => {
    const places = { preferences: { home_city: "Berlin", places: [moving("berlin"), moving("Paris")], workplace: all }, geo, home };
    expect(onsiteSearchTexts(places)).toEqual(["Berlin", "Paris"]);
  });
});

describe("searches the old keys did not list", () => {
  const beyond = (search: Parameters<typeof placesBeyondSearchEntries>[0], places: { place: string; relocate: boolean }[], workplace = all, home_city = "Berlin") => placesBeyondSearchEntries(search, { home_city, places, workplace }, geo, home);

  it("are quiet without the keys, and when the two files agree", () => {
    expect(beyond({}, [moving("Paris")])).toEqual([]);
    expect(beyond({ locations: ["Berlin", "Paris"], remote_scope: { region: ["CH", "XA"] } }, [moving("Paris"), remoteOnly("CH")], ["onsite"])).toEqual([]);
  });

  it("name a place or home city the old list lacked", () => {
    expect(beyond({ locations: ["Berlin"], remote_scope: "home_country" }, [moving("Paris"), remoteOnly("NL")])).toEqual(["Paris", "NL"]);
    expect(beyond({ locations: ["Paris"] }, [moving("Paris")])).toEqual(["Berlin"]);
  });

  it("read only the keys the file has", () => {
    expect(beyond({ remote_scope: "home_country" }, [moving("Paris")], ["onsite"])).toEqual([]);
    expect(beyond({ locations: ["Berlin"] }, [remoteOnly("Paris")])).toEqual([]);
    expect(beyond({ locations: ["Berlin"] }, [moving("Worldwide")])).toEqual([]);
  });

  it("name the remote search a place abroad gains, even when the old list had the place", () => {
    expect(beyond({ locations: ["Berlin", "Paris"], remote_scope: "home_country" }, [moving("Paris")])).toEqual(["Paris"]);
    expect(beyond({ locations: ["Berlin", "NL"], remote_scope: "home_country" }, [remoteOnly("NL")])).toEqual(["NL"]);
  });

  it("do not name a remote search nobody runs, or home under another token", () => {
    expect(beyond({ remote_scope: "home_country" }, [remoteOnly("NL")], ["onsite"])).toEqual([]);
    expect(beyond({ remote_scope: "home_country" }, [remoteOnly("XA")])).toEqual([]);
  });

  it("name the home country when remote search of it is new", () => {
    expect(beyond({ remote_scope: "none" }, [])).toEqual(["Xaland"]);
    expect(beyond({ remote_scope: { region: ["CH"] } }, [remoteOnly("CH")])).toEqual(["Xaland"]);
    expect(beyond({ remote_scope: "none" }, [], ["onsite"])).toEqual([]);
    expect(beyond({ remote_scope: "home_country" }, [])).toEqual([]);
  });
});
