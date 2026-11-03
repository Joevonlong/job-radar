// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { HighValuePolicy } from "@/lib/db";
import type { SavedView } from "@/lib/config/schemas/interests";
import { viewTrendInput } from "@/lib/interests/view-trends";

const policy: HighValuePolicy = { amountId: null, amountHighValue: false, otherIds: [], minAnnualEur: null, rates: {}, otherRegionPoints: 0 };
const context = { cityGroups: null, hideGermanLevels: [], highValue: policy };

// The trend query itself drops any date condition (tests/integration/jobs-company-filter.test.ts); this only pins that the
// other conditions of a view survive the translation when the view also carries dates.
describe("view trends keep the other conditions of a view that has a date condition", () => {
  const trend = (filters: SavedView["filters"]) => viewTrendInput({ id: "v", name: "V", default: false, filters }, context).filters;

  it.each([
    ["a quick range", { city: "Berlin", within: "7d", dateBy: "posted" } as const],
    ["custom dates", { city: "Berlin", from: "2026-10-01", to: "2026-10-15", dateBy: "posted" } as const],
  ])("%s does not change the city condition", (_name, filters) => {
    expect(trend(filters).cities).toEqual(["Berlin"]);
  });
});
