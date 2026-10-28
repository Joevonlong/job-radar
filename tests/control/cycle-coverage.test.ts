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

  describe("with a cascade (only its first selected member collects)", () => {
    const cascades = [{ order: ["li-first", "li-second", "li-third"] }];

    it("a full cycle covers the cascade's first member, never a later one asked for by name", () => {
      expect(cycleCovers(null, ["li-first"], cascades)).toBe(true);
      expect(cycleCovers(null, ["li-second"], cascades)).toBe(false);
      expect(cycleCovers(undefined, ["indeed", "li-third"], cascades)).toBe(false);
      expect(cycleCovers(null, ["indeed"], cascades)).toBe(true);
    });

    it("a cycle limited to cascade members covers the member it leads with", () => {
      expect(cycleCovers(["li-second"], ["li-second"], cascades)).toBe(true);
      // limited to two of them it still collects with the first only
      expect(cycleCovers(["li-first", "li-second"], ["li-second"], cascades)).toBe(false);
      expect(cycleCovers(["li-first", "li-second"], ["li-first"], cascades)).toBe(true);
      // what a request of two members would collect with: its first one
      expect(cycleCovers(["li-second"], ["li-second", "li-third"], cascades)).toBe(true);
    });

    it("without the cascades every channel is compared by name", () => {
      expect(cycleCovers(null, ["li-second"])).toBe(true);
    });
  });
});
