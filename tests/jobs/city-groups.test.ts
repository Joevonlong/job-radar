import { describe, expect, it } from "vitest";

import { locationSearchTerms } from "@/lib/jobs/city-aliases";
import { buildCityGroups, cityMembers, type CityRow } from "@/lib/jobs/city-groups";

import { shippedPipeline } from "../pipeline/helpers";

const pipeline = shippedPipeline();
const filter = pipeline.filter;
const market = pipeline.market;
const config = { targets: ["Berlin", "München"], filter, market };

let jobId = 0;
const row = (city: string, extra: Partial<CityRow> = {}): CityRow => ({ jobId: ++jobId, city, label: city, countryCode: "DE", ...extra });

describe("buildCityGroups", () => {
  it("folds a target city, its spellings and the towns of its metro area into one entry", () => {
    const groups = buildCityGroups(
      [row("München"), row("Munich"), row("Garching"), row("Greater Munich Metropolitan Area"), row("Poing bei München"), row("Unterföhring"), row("Munich, Bavaria", { label: "Munich, Bavaria, Germany" })],
      config,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "München", target: true, jobCount: 7 });
    expect(groups[0]?.members).toEqual(expect.arrayContaining(["München", "Munich", "Garching", "Greater Munich Metropolitan Area", "Poing bei München", "Unterföhring", "Munich, Bavaria"]));
  });

  it("folds Berlin and its metro area, not a town elsewhere", () => {
    const groups = buildCityGroups([row("Berlin"), row("Berlin Metropolitan Area"), row("Potsdam"), row("Hamburg")], config);
    expect(groups.map((g) => [g.key, g.jobCount])).toEqual([
      ["Berlin", 3],
      ["Hamburg", 1],
    ]);
  });

  it("normalizes other cities with the pipeline's city table: 'Nürnberg, Mittelfranken' and Nuremberg are Nürnberg", () => {
    const groups = buildCityGroups([row("Nürnberg, Mittelfranken"), row("Nuremberg"), row("Nürnberg"), row("Cologne"), row("Köln")], config);
    expect(groups.map((g) => [g.key, g.jobCount, g.target])).toEqual([
      ["Nürnberg", 3, false],
      ["Köln", 2, false],
    ]);
    expect(groups[0]?.members).toEqual(expect.arrayContaining(["Nürnberg, Mittelfranken", "Nuremberg", "Nürnberg"]));
  });

  it("lists the target cities first, in the order of preferences.yaml, then the others by number of jobs", () => {
    const rows = [row("Hamburg"), row("Hamburg"), row("Köln"), row("München"), row("Berlin"), row("Berlin"), row("Aachen")];
    expect(buildCityGroups(rows, config).map((g) => g.key)).toEqual(["Berlin", "München", "Hamburg", "Aachen", "Köln"]);
    expect(buildCityGroups(rows, { ...config, targets: ["München", "Berlin"] }).map((g) => g.key).slice(0, 2)).toEqual(["München", "Berlin"]);
  });

  it("counts a job once per group, even when two of its locations fall into the same one", () => {
    const groups = buildCityGroups([{ jobId: 1, city: "München", label: "München", countryCode: "DE" }, { jobId: 1, city: "Garching", label: "Garching", countryCode: "DE" }], config);
    expect(groups).toMatchObject([{ key: "München", jobCount: 1 }]);
  });

  it("leaves out regions and country-level values: they are not cities", () => {
    const groups = buildCityGroups([row("Bavaria"), row("Germany"), row("Deutschland"), row("Hamburg")], config);
    expect(groups.map((g) => g.key)).toEqual(["Hamburg"]);
  });

  it("does not put a same-named town in another country into a target city", () => {
    const groups = buildCityGroups([row("Haar", { countryCode: "NL" }), row("Feldkirchen", { countryCode: "AT" })], config);
    expect(groups.map((g) => g.key)).toEqual(["Feldkirchen", "Haar"]);
    expect(groups.every((g) => !g.target)).toBe(true);
  });

  it("works without targets (preferences.yaml unreadable)", () => {
    const groups = buildCityGroups([row("München"), row("Munich")], { ...config, targets: [] });
    expect(groups).toMatchObject([{ key: "München", target: false, jobCount: 2 }]);
  });
});

describe("cityMembers", () => {
  const groups = buildCityGroups([row("München"), row("Garching"), row("Hamburg")], config);

  it("gives every raw value behind a group, so München also finds Garching", () => {
    expect(cityMembers(groups, "München")).toEqual(expect.arrayContaining(["München", "Garching"]));
    expect(cityMembers(groups, "muenchen")).toEqual(["muenchen"]);
    expect(cityMembers(groups, "hamburg")).toEqual(["Hamburg"]);
  });

  it("returns an unknown value as it is", () => {
    expect(cityMembers(groups, "Atlantis")).toEqual(["Atlantis"]);
  });
});

describe("city dropdown and search", () => {
  it("puts Erding and Allershausen into the Munich group", () => {
    const groups = buildCityGroups([row("Erding"), row("Allershausen"), row("München")], config);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "München", jobCount: 3 });
  });

  it("leaves 'Home Office' and 'Remotely In' out of the dropdown", () => {
    const groups = buildCityGroups([row("Home Office", { countryCode: null }), row("Remotely In", { countryCode: null }), row("Hamburg")], config);
    expect(groups.map((g) => g.key)).toEqual(["Hamburg"]);
  });

  it("expands a city search to its spellings", () => {
    expect(locationSearchTerms("München", filter.city_aliases, market.transliterations)).toEqual(expect.arrayContaining(["München", "Munich", "Muenchen"]));
    expect(locationSearchTerms("muenchen", filter.city_aliases, market.transliterations)).toEqual(expect.arrayContaining(["Munich"]));
    expect(locationSearchTerms("Hamburg", filter.city_aliases, market.transliterations)).toEqual(["Hamburg"]);
    expect(locationSearchTerms("  ", filter.city_aliases, market.transliterations)).toEqual([]);
  });
});
