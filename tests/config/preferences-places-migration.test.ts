import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

import { buildQueries } from "@/lib/channels/query";
import { parseConfigText } from "@/lib/config";
import { preferences003 } from "@/lib/config/migrations/preferences/003-places";
import { evaluateJob } from "@/lib/filter";
import { normalizePlaces, placeGeo, wantedLocations, wantedRemoteScope, type PlaceGeo } from "@/lib/market/places";

import { shippedSearch } from "../channels/helpers";
import { filterWith, job, loc } from "../filter/helpers";

const geo: PlaceGeo = placeGeo({
  filter: { city_aliases: {} },
  market: {
    cities: { amsterdam: ["Amsterdam", "NL"], berlin: ["Berlin", "XA"], munich: ["München", "XA"], "münchen": ["München", "XA"] },
    countries: [{ code: "XA", name: "Xaland", aliases: [] }, { code: "CH", name: "Switzerland", aliases: [] }],
    regions: { eu: { name: "European Union", countries: ["XA", "NL"] } },
  },
});

function migrate(text: string): Record<string, unknown> {
  const doc = parseDocument(`target_titles: [Engineer]\n${text}`);
  preferences003.migrate(doc);
  return doc.toJS() as Record<string, unknown>;
}

const read = (out: Record<string, unknown>) => out as unknown as { home_city: string; places: Array<{ place: string; relocate: boolean }> };

/** A whole preferences.yaml of the given version; `body` holds the location keys. */
const preferencesFile = (version: number, body: string, workplace = "[onsite, remote]"): string => `config_version: ${version}
market: {pack: de}
target_titles: [Engineer]
${body}
workplace: ${workplace}
seniority: all
salary_floor_year: 0
contracts: {allow: [permanent], exclude: []}
exclude_student_roles: true
exclude_companies: []
exclude_keywords: []
`;

const load = (text: string) => parseConfigText("preferences", text, "preferences.yaml");

describe("preferences.yaml 2 -> 3", () => {
  it("the first location is the home city, the others are places to move to", () => {
    const out = migrate("locations: [Berlin, Amsterdam]\nworkplace: [onsite]\nremote_scope: home_country\n");
    expect(out).toMatchObject({ home_city: "Berlin", places: [{ place: "Amsterdam", relocate: true }] });
    expect(out).not.toHaveProperty("locations");
    expect(out).not.toHaveProperty("remote_scope");
  });

  it("a foreign first location is the home city: a step reads no tables", () => {
    expect(migrate("locations: [Amsterdam, Berlin]\nworkplace: [onsite]\nremote_scope: home_country\n")).toMatchObject({ home_city: "Amsterdam", places: [{ place: "Berlin", relocate: true }] });
  });

  it("scope tokens stay as written, as remote-only places; Worldwide too", () => {
    expect(migrate("locations: [Berlin]\nworkplace: [remote]\nremote_scope: {region: [eu, CH]}\n").places).toEqual([{ place: "eu", relocate: false }, { place: "CH", relocate: false }]);
    expect(migrate("locations: [Berlin]\nworkplace: [remote]\nremote_scope: worldwide\n").places).toEqual([{ place: "Worldwide", relocate: false }]);
  });

  it("none takes remote out of workplace, unless it is the only value", () => {
    expect(migrate("locations: [Berlin]\nworkplace: [onsite, remote]\nremote_scope: none\n")).toMatchObject({ workplace: ["onsite"], places: [] });
    expect(migrate("locations: [Berlin]\nworkplace: [remote]\nremote_scope: none\n")).toMatchObject({ workplace: ["remote"], places: [] });
  });

  it("a place in both keys is one ✈ entry, and the home city is not repeated", () => {
    expect(migrate("locations: [Berlin, CH, berlin]\nworkplace: [remote]\nremote_scope: {region: [CH]}\n").places).toEqual([{ place: "CH", relocate: true }]);
  });

  it("a country in both keys keeps both roles: its remote jobs stay in scope, and so do the home country's", () => {
    const prefs = read(migrate("locations: [Berlin, CH]\nworkplace: [remote]\nremote_scope: {region: [CH]}\n"));
    expect(prefs.places).toEqual([{ place: "CH", relocate: true }]);
    expect(wantedRemoteScope(prefs, geo, "XA")).toEqual({ region: ["XA", "CH"] });
  });

  it.each([
    ["home_country", "home_country"],
    ["worldwide", "worldwide"],
    ["{region: [eu]}", { region: ["eu"] }],
    ["{region: [eu, CH]}", { region: ["eu", "CH"] }],
  ])("a migrated %s reads back as the same locations and scope", (scope, expected) => {
    const prefs = read(migrate(`locations: [Berlin, Amsterdam]\nworkplace: [remote]\nremote_scope: ${scope}\n`));
    expect(wantedLocations(prefs)).toEqual(["Berlin", "Amsterdam"]);
    expect(wantedRemoteScope(prefs, geo, "XA")).toEqual(expected);
  });
});

describe("the upgrade through the config loader", () => {
  it("[Berlin, CH] with a Swiss remote scope still keeps Swiss and German remote jobs", () => {
    const prefs = load(preferencesFile(2, "locations: [Berlin, CH]\nremote_scope: {region: [CH]}"));
    expect(prefs.places).toEqual([{ place: "CH", relocate: true }]);
    const filter = filterWith(prefs);
    expect(evaluateJob(job({ workplace: "remote", locations: [loc("Zürich, Switzerland", "Zürich", "CH")] }), filter).result).toBe("passed");
    expect(evaluateJob(job({ workplace: "remote", locations: [loc("Hamburg, Germany", "Hamburg", "DE")] }), filter).result).toBe("passed");
    expect(evaluateJob(job({ workplace: "remote", locations: [loc("Paris, France", "Paris", "FR")] }), filter).reasons).toEqual(["remote_out_of_scope:Paris"]);
  });

  it("a version 2 file with more than 50 locations stays readable", () => {
    const cities = Array.from({ length: 60 }, (_, i) => `Town ${i}`);
    const prefs = load(preferencesFile(2, `locations: [${cities.join(", ")}]\nremote_scope: home_country`));
    expect(prefs.home_city).toBe("Town 0");
    expect(prefs.places).toHaveLength(59);
  });

  it("a version 2 file with a location name over 100 characters stays readable", () => {
    const long = `Town ${"x".repeat(120)}`;
    const prefs = load(preferencesFile(2, `locations: [Berlin, ${long}]\nremote_scope: home_country`));
    expect(prefs.places).toEqual([{ place: long, relocate: true }]);
    expect(load(preferencesFile(3, `home_city: ${long}\nplaces: []`)).home_city).toBe(long);
  });

  it("a version 2 file with 60 locations and a long remote scope list stays readable", () => {
    const cities = Array.from({ length: 60 }, (_, i) => `Town ${i}`);
    const prefs = load(preferencesFile(2, `locations: [${cities.join(", ")}]\nremote_scope: {region: [eu, CH, AT, NL, PL]}`));
    expect(prefs.places).toHaveLength(64);
  });
});

describe("the old `none`: what jobs I want and what is collected are separate", () => {
  const remoteBerlin = job({ workplace: "remote", locations: [loc("Berlin, Germany", "Berlin", "DE")] });
  const onsiteBerlin = job({ workplace: "onsite", locations: [loc("Berlin, Germany", "Berlin", "DE")] });

  it("preferences: an upgraded none hides remote jobs through the workplace rule and keeps the others", () => {
    const filter = filterWith(load(preferencesFile(2, "locations: [Berlin]\nremote_scope: none")));
    expect(evaluateJob(remoteBerlin, filter)).toEqual({ result: "filtered_out", reasons: ["workplace_not_wanted:remote"] });
    expect(evaluateJob(onsiteBerlin, filter).result).toBe("passed");
  });

  it("preferences: none with workplace [remote] keeps remote, so remote jobs are checked against the scope instead of hidden", () => {
    const prefs = load(preferencesFile(2, "locations: [Berlin]\nremote_scope: none", "[remote]"));
    expect(prefs.workplace).toEqual(["remote"]);
    const filter = filterWith(prefs);
    expect(evaluateJob(remoteBerlin, filter).result).toBe("passed");
    expect(evaluateJob(job({ workplace: "remote", locations: [loc("Austin, TX", "Austin", "US")] }), filter).reasons).toEqual(["remote_out_of_scope:Austin"]);
  });

  it("collection: search.yaml none alone stops remote queries; the preferences never start or stop them", () => {
    expect(buildQueries({ ...shippedSearch(), remote_scope: "none" }, "manual").some((q) => q.remote)).toBe(false);
    expect(buildQueries({ ...shippedSearch(), remote_scope: "home_country" }, "manual").some((q) => q.remote)).toBe(true);
    // an opt-out of collection does not hide anything: the filter reads only the preferences
    expect(evaluateJob(remoteBerlin, filterWith(load(preferencesFile(3, "home_city: Berlin\nplaces: []")))).result).toBe("passed");
  });
});

describe("normalizePlaces: one reading of places, whatever wrote them", () => {
  const home = "Berlin";
  const run = (places: Array<{ place: string; relocate: boolean }>, tables: PlaceGeo | null = null) => normalizePlaces({ home_city: home, places }, tables).places;

  it("Worldwide is remote only", () => {
    expect(run([{ place: "Worldwide", relocate: true }])).toEqual([{ place: "Worldwide", relocate: false }]);
    expect(run([{ place: " worldwide ", relocate: true }])).toEqual([{ place: " worldwide ", relocate: false }]);
  });

  it("drops a place that is the home city", () => {
    expect(run([{ place: "berlin", relocate: true }, { place: "Amsterdam", relocate: true }])).toEqual([{ place: "Amsterdam", relocate: true }]);
  });

  it("merges a place named twice at its first position; ✈ wins over remote only, in either order", () => {
    expect(run([{ place: "CH", relocate: false }, { place: "Amsterdam", relocate: true }, { place: "ch", relocate: true }])).toEqual([{ place: "CH", relocate: true }, { place: "Amsterdam", relocate: true }]);
    expect(run([{ place: "Amsterdam", relocate: true }, { place: "AMSTERDAM", relocate: false }])).toEqual([{ place: "Amsterdam", relocate: true }]);
    expect(run([{ place: "Atlantis", relocate: false }, { place: "Atlantis", relocate: false }])).toEqual([{ place: "Atlantis", relocate: false }]);
  });

  it("with the tables, two spellings of one place are one entry; unknown names compare as written", () => {
    expect(run([{ place: "Munich", relocate: false }, { place: "München", relocate: true }], geo)).toEqual([{ place: "Munich", relocate: true }]);
    expect(run([{ place: "Switzerland", relocate: false }, { place: "CH", relocate: true }], geo)).toEqual([{ place: "Switzerland", relocate: true }]);
    expect(run([{ place: "Atlantis", relocate: true }, { place: "Atlantís", relocate: false }], geo)).toEqual([{ place: "Atlantis", relocate: true }]);
    expect(run([{ place: "Munich", relocate: false }, { place: "München", relocate: true }])).toHaveLength(2);
  });

  it("returns the same object when there is nothing to change", () => {
    const prefs = { home_city: home, places: [{ place: "Amsterdam", relocate: true }] };
    expect(normalizePlaces(prefs)).toBe(prefs);
  });

  it("is what the config loader reads from a file edited by hand", () => {
    const prefs = load(
      preferencesFile(3, "home_city: Berlin\nplaces:\n  - {place: Worldwide, relocate: true}\n  - {place: CH, relocate: false}\n  - {place: Berlin, relocate: true}\n  - {place: ch, relocate: true}\n  - {place: Amsterdam, relocate: true}\n  - {place: Amsterdam, relocate: true}"),
    );
    expect(prefs.places).toEqual([
      { place: "Worldwide", relocate: false },
      { place: "CH", relocate: true },
      { place: "Amsterdam", relocate: true },
    ]);
  });
});

describe("wantedRemoteScope", () => {
  const scope = (...places: string[]) => wantedRemoteScope({ home_city: "Berlin", places: places.map((place) => ({ place, relocate: false })) }, geo, "XA");
  const moving = (...places: string[]) => wantedRemoteScope({ home_city: "Berlin", places: places.map((place) => ({ place, relocate: true })) }, geo, "XA");

  it("reads names as well as tokens", () => {
    expect(scope("European Union", "Switzerland")).toEqual({ region: ["eu", "CH"] });
  });

  it("is never none, and a city or an unknown name adds nothing", () => {
    expect(scope()).toBe("home_country");
    expect(scope("Amsterdam", "Atlantis")).toBe("home_country");
    expect(moving("Amsterdam", "Atlantis")).toBe("home_country");
  });

  it("counts a country or region to move to: with no remote-only one, next to the home country", () => {
    expect(moving("eu")).toEqual({ region: ["XA", "eu"] });
    expect(moving("Xaland")).toBe("home_country");
    expect(wantedRemoteScope({ home_city: "Berlin", places: [{ place: "eu", relocate: false }, { place: "CH", relocate: true }] }, geo, "XA")).toEqual({ region: ["eu", "CH"] });
  });

  it("Worldwide anywhere is worldwide", () => {
    expect(moving("Worldwide")).toBe("worldwide");
  });
});
