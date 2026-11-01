// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { HighValuePolicy } from "@/lib/db";
import type { SavedView } from "@/lib/config/schemas/interests";
import { viewTrendInput } from "@/lib/interests/view-trends";

const policy: HighValuePolicy = { amountId: null, amountHighValue: false, otherIds: [], minAnnualEur: null, rates: {}, otherRegionPoints: 0 };
const context = { cityGroups: null, hideGermanLevels: [], highValue: policy };

describe("view trends ignore the date condition of a view", () => {
  const trend = (filters: SavedView["filters"]) => viewTrendInput({ id: "v", name: "V", default: false, filters }, context).filters;

  it.each([
    ["a quick range", { city: "Berlin", within: "7d", dateBy: "posted" } as const],
    ["custom dates", { city: "Berlin", from: "2026-10-01", to: "2026-10-15", dateBy: "posted" } as const],
  ])("passes %s on to the query nowhere: the window is the last days of the chart", (_name, filters) => {
    const result = trend(filters);
    expect(result.cities).toEqual(["Berlin"]);
    for (const key of ["within", "from", "to", "dateField", "now"] as const) expect(result[key] ?? null).toBeNull();
  });
});
