import { describe, expect, it } from "vitest";

import { priorityWeightSum } from "@/components/settings/ai/scoring-section";
import { configToDraft } from "@/lib/settings/draft";

import { shippedConfig } from "./helpers";

describe("pre-sort weights sum", () => {
  it("adds the six weights as typed; an empty or invalid box counts as zero", () => {
    const draft = configToDraft("ai", shippedConfig("ai"));
    const shipped = priorityWeightSum(draft);
    expect(shipped).toBeGreaterThan(0);
    draft["scoring.priority.weights.title"] = "0";
    draft["scoring.priority.weights.signals"] = "";
    draft["scoring.priority.weights.location"] = "abc";
    const without = priorityWeightSum(draft);
    expect(without).toBeLessThan(shipped);
    draft["scoring.priority.weights.title"] = "12.5";
    expect(priorityWeightSum(draft)).toBe(without + 12.5);
  });
});
