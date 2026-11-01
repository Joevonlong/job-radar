import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCityGroups, type CityGroupConfig, type CityRow } from "@/lib/jobs/city-groups";

import { shippedPipeline } from "../pipeline/helpers";

const calls = vi.hoisted(() => ({ normalize: [] as string[] }));
vi.mock("@/lib/pipeline/geography", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/pipeline/geography")>();
  return { ...original, normalizeLocation: (raw: string, market: Parameters<typeof original.normalizeLocation>[1]) => { calls.normalize.push(raw); return original.normalizeLocation(raw, market); } };
});

// The equivalence test guards the result; this one guards the cost: a placement is worked out once per distinct
// location, so the dropdown stays cheap when every job repeats the same few places (a user with 100k jobs).
describe("buildCityGroups cost", () => {
  const pipeline = shippedPipeline();
  const config: CityGroupConfig = { filter: pipeline.filter, market: pipeline.market, targets: ["Berlin"] };
  beforeEach(() => { calls.normalize.length = 0; });

  const repeated = (copies: number): CityRow[] => {
    const places = [
      { city: "Hamburg", label: "Hamburg, Germany", countryCode: "DE" },
      { city: "Hamburg", label: "Hamburg", countryCode: "DE" },
      { city: "Wien", label: "Wien", countryCode: "AT" },
      { city: "Köln", label: "Köln", countryCode: "DE" },
      { city: "Berlin", label: "Berlin", countryCode: "DE" },
    ];
    return Array.from({ length: copies }, (_, i) => places.map((place, j) => ({ jobId: i * places.length + j + 1, ...place }))).flat();
  };

  it("normalizes each distinct city name once, however many rows repeat it", () => {
    buildCityGroups(repeated(1), config);
    const once = calls.normalize.length;
    expect(once).toBeGreaterThan(0);
    // Hamburg appears with two labels but is one city value; Berlin is a target and never normalized
    expect(once).toBeLessThanOrEqual(3);
    expect(new Set(calls.normalize).size).toBe(once);
    calls.normalize.length = 0;
    const groups = buildCityGroups(repeated(400), config);
    expect(calls.normalize.length).toBe(once);
    expect(groups.find((group) => group.key === "Berlin")?.jobCount).toBe(400);
  });

  it("places a repeated (city, label, country) tuple once: the call count does not grow with the row count", () => {
    const count = (copies: number) => { calls.normalize.length = 0; buildCityGroups(repeated(copies), config); return calls.normalize.length; };
    expect(count(2000)).toBe(count(1));
  });
});
