import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

import { preferences003 } from "@/lib/config/migrations/preferences/003-places";
import { placeGeo, wantedLocations, wantedRemoteScope, type PlaceGeo } from "@/lib/market/places";

const geo: PlaceGeo = placeGeo({
  filter: { city_aliases: {} },
  market: {
    cities: { amsterdam: ["Amsterdam", "NL"], berlin: ["Berlin", "XA"] },
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

  it("a place named twice keeps its first entry, and the home city is not repeated", () => {
    expect(migrate("locations: [Berlin, CH, berlin]\nworkplace: [remote]\nremote_scope: {region: [CH]}\n").places).toEqual([{ place: "CH", relocate: true }]);
  });

  it.each([
    ["home_country", "home_country"],
    ["worldwide", "worldwide"],
    ["{region: [eu]}", { region: ["eu"] }],
    ["{region: [eu, CH]}", { region: ["eu", "CH"] }],
  ])("a migrated %s reads back as the same locations and scope", (scope, expected) => {
    const prefs = read(migrate(`locations: [Berlin, Amsterdam]\nworkplace: [remote]\nremote_scope: ${scope}\n`));
    expect(wantedLocations(prefs)).toEqual(["Berlin", "Amsterdam"]);
    expect(wantedRemoteScope(prefs, geo)).toEqual(expected);
  });
});

describe("wantedRemoteScope", () => {
  const scope = (...places: string[]) => wantedRemoteScope({ home_city: "Berlin", places: places.map((place) => ({ place, relocate: false })) }, geo);

  it("reads names as well as tokens", () => {
    expect(scope("European Union", "Switzerland")).toEqual({ region: ["eu", "CH"] });
  });

  it("is never none, and a city or an unknown name adds nothing", () => {
    expect(scope()).toBe("home_country");
    expect(scope("Amsterdam", "Atlantis")).toBe("home_country");
  });

  it("does not count a place to move to", () => {
    expect(wantedRemoteScope({ home_city: "Berlin", places: [{ place: "eu", relocate: true }] }, geo)).toBe("home_country");
  });
});

describe("preferences.yaml 2 -> 3, run on its own result", () => {
  it("changes nothing the second time", () => {
    const doc = parseDocument("target_titles: [Engineer]\nlocations: [Berlin, Amsterdam]\nremote_scope: {region: [CH]}\n");
    preferences003.migrate(doc);
    const once = doc.toJS() as unknown;
    preferences003.migrate(doc);
    expect(doc.toJS()).toEqual(once);
  });
});
