import { describe, expect, it } from "vitest";

import { tickIndexes, tickSets } from "@/components/insights/column-chart";

describe("axis ticks", () => {
  it("labels every column while there are few", () => {
    expect([...tickIndexes(7, 14)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps the phone labels inside the desktop labels and the counts within the limits", () => {
    for (const count of [7, 14, 21, 30, 90, 3, 8]) {
      const { phone, desktop } = tickSets(count, 5, 12);
      expect(phone.size).toBeLessThanOrEqual(5);
      expect(desktop.size).toBeLessThanOrEqual(12);
      for (const index of phone) expect(desktop.has(index)).toBe(true);
    }
  });
});
