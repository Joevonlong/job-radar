// @vitest-environment node
import { describe, expect, it } from "vitest";

import { pickApplyTarget, targetPlaceNames } from "@/lib/dashboard/apply";
import type { JobSourceRef } from "@/lib/db/queries/types";

const source = (locationLabel: string | null, priority: number, url = `https://x.test/${locationLabel ?? "none"}`): JobSourceRef => ({
  channelId: "c",
  family: "ats",
  url,
  applyUrl: null,
  locationLabel,
  priority,
});

const places = targetPlaceNames(
  { home_city: "Berlin", places: [{ place: "München", relocate: true }] },
  { filter: { city_aliases: { Berlin: [], München: ["Munich", "Muenchen"] }, metro_areas: { München: ["Garching"] } }, market: { cities: {}, countries: [], regions: {} } },
);

describe("pickApplyTarget", () => {
  it("keeps the best priority when no place is wanted or none matches", () => {
    const list = [source("Amsterdam", 2), source("London", 1)];
    expect(pickApplyTarget(list)?.locationLabel).toBe("London");
    expect(pickApplyTarget(list, places)?.locationLabel).toBe("London");
  });

  it("prefers a source in a wanted city over a better-priority one elsewhere", () => {
    const list = [source("Amsterdam", 1), source("Berlin; Munich", 3), source("Munich", 2)];
    expect(pickApplyTarget(list, places)?.locationLabel).toBe("Munich");
    expect(pickApplyTarget([source("Amsterdam", 1), source("Garching bei München", 5)], places)?.locationLabel).toBe("Garching bei München");
  });

  it("ignores sources without a link", () => {
    expect(pickApplyTarget([source("Berlin", 1, null as unknown as string), source("Amsterdam", 2)], places)?.locationLabel).toBe("Amsterdam");
  });
});

describe("the metro towns of a wanted city", () => {
  const hurth = targetPlaceNames(
    { home_city: "Cologne", places: [] },
    { filter: { city_aliases: {}, metro_areas: { Koeln: ["Hürth"] } }, market: { cities: { "köln": ["Köln", "DE"], cologne: ["Köln", "DE"] }, countries: [], regions: {} } },
  );

  it("reads a metro key in any spelling of the city, so the Hürth link wins over another location's", () => {
    expect(hurth).toEqual(expect.arrayContaining(["Hürth"]));
    const sources = [source("Berlin", 1), source("Hürth", 5), source("Amsterdam", 2)];
    expect(pickApplyTarget(sources, hurth)?.locationLabel).toBe("Hürth");
  });

  it("leaves another city's metro towns out", () => {
    const names = targetPlaceNames(
      { home_city: "Cologne", places: [] },
      { filter: { city_aliases: {}, metro_areas: { Koeln: ["Hürth"], Munich: ["Garching"] } }, market: { cities: { "köln": ["Köln", "DE"], munich: ["München", "DE"] }, countries: [], regions: {} } },
    );
    expect(names).not.toContain("Garching");
  });
});

