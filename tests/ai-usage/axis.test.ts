import { describe, expect, it } from "vitest";

import { niceAxisMax } from "@/lib/ai-usage/axis";

describe("niceAxisMax", () => {
  it("keeps whole halves for counts", () => {
    for (const max of [1, 3, 7, 11, 99, 1234, 7172.5 * 2 - 1, 15_000, 888_401]) {
      const nice = niceAxisMax(max, true);
      expect(nice).toBeGreaterThanOrEqual(max);
      expect(Number.isInteger(nice / 2)).toBe(true);
    }
    expect(niceAxisMax(14345, true)).toBe(16_000);
    expect(niceAxisMax(0, true)).toBe(0);
  });
  it("rounds money up to a round amount", () => {
    expect(niceAxisMax(0.0287, false)).toBe(0.03);
    expect(niceAxisMax(1.39, false)).toBe(1.4);
    expect(niceAxisMax(2.21, false)).toBe(2.5);
  });
});
