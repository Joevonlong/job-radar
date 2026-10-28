// @vitest-environment node
import { describe, expect, it } from "vitest";

import { cycleCovers } from "@/lib/control/cycle-coverage";

describe("cycleCovers", () => {
  it("a cycle of every channel (no list, or an empty one) covers anything", () => {
    for (const holder of [undefined, null, []]) {
      expect(cycleCovers(holder, undefined)).toBe(true);
      expect(cycleCovers(holder, ["indeed"])).toBe(true);
    }
  });

  it("a cycle limited to some channels never covers one of every channel", () => {
    for (const wanted of [undefined, null, []]) expect(cycleCovers(["indeed", "greenhouse"], wanted)).toBe(false);
  });

  it("covers exactly the subsets of its channels", () => {
    expect(cycleCovers(["indeed", "greenhouse"], ["greenhouse"])).toBe(true);
    expect(cycleCovers(["indeed", "greenhouse"], ["greenhouse", "indeed"])).toBe(true);
    expect(cycleCovers(["indeed"], ["indeed"])).toBe(true);
    expect(cycleCovers(["indeed"], ["greenhouse"])).toBe(false);
    expect(cycleCovers(["indeed"], ["indeed", "greenhouse"])).toBe(false);
  });
});
