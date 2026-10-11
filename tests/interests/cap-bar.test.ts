import { describe, expect, it } from "vitest";

import { capBar, parseWeight, weightScale } from "@/lib/interests/cap-bar";

const shipped = { T1: "10", T2: "8", T3: "3", T4: "2" };
/** Category weights as typed, in list order (any number of categories). */
const w = (weights: Record<string, string>) => Object.entries(weights).map(([id, weight]) => ({ id, weight }));

describe("parseWeight", () => {
  it("accepts plain non-negative decimals only", () => {
    expect(parseWeight("8")).toBe(8);
    expect(parseWeight(" 2.5 ")).toBe(2.5);
    for (const bad of ["", "abc", "-1", "1e3", "1,5"]) expect(parseWeight(bad)).toBeNull();
  });
});

describe("capBar", () => {
  it("stacks the categories and hatches what sticks out past the cap (shipped weights: 23 against a cap of 15)", () => {
    const bar = capBar(w(shipped), "15");
    expect(bar.sum).toBe(23);
    expect(bar.counted).toBe(15);
    expect(bar.over).toBe(8);
    expect(bar.segments.map((s) => s.value)).toEqual([10, 8, 3, 2]);
    expect(bar.segments.reduce((total, s) => total + s.width, 0)).toBeCloseTo(100, 0);
    expect(bar.capAt).toBeCloseTo((15 / 23) * 100, 1);
    expect(bar.overflow?.left).toBe(bar.capAt);
    expect(bar.overflow?.width).toBeCloseTo((8 / 23) * 100, 1);
  });

  it("fills the track: the scale is the larger of the sum and the cap", () => {
    expect(capBar(w(shipped), "15").scale).toBe(23);
    const roomy = capBar(w({ T1: "5", T2: "4", T3: "3", T4: "2" }), "30");
    expect(roomy.scale).toBe(30);
    expect(roomy.capAt).toBe(100);
    expect(roomy.segments.reduce((total, s) => total + s.width, 0)).toBeCloseTo((14 / 30) * 100, 0);
  });

  it("has no hatch while the sum stays under the cap, and counts the whole sum", () => {
    const bar = capBar(w({ T1: "5", T2: "4", T3: "3", T4: "2" }), "15");
    expect(bar).toMatchObject({ sum: 14, counted: 14, over: 0, overflow: null });
  });

  it("follows what is typed: a weight that is not a number counts as nothing, a missing cap draws no line", () => {
    const bar = capBar(w({ ...shipped, T3: "abc" }), "");
    expect(bar.sum).toBe(20);
    expect(bar.cap).toBeNull();
    expect(bar.capAt).toBeNull();
    expect(bar.counted).toBe(20);
    expect(bar.overflow).toBeNull();
  });

  it("changes as soon as one weight changes (the stepper)", () => {
    expect(capBar(w({ ...shipped, T2: "9" }), "15").sum).toBe(24);
    expect(capBar(w({ ...shipped, T1: "0", T2: "0" }), "15")).toMatchObject({ sum: 5, counted: 5, over: 0 });
  });
});

describe("weightScale", () => {
  it("is one point a cell up to 10, then grows in steps of 10 so a weight of 20 is not drawn like 10", () => {
    expect(weightScale(w(shipped))).toEqual({ max: 10, perCell: 1 });
    expect(weightScale(w({ ...shipped, T1: "20" }))).toEqual({ max: 20, perCell: 2 });
    expect(weightScale(w({ ...shipped, T1: "20.5" }))).toEqual({ max: 30, perCell: 3 });
    expect(weightScale(w({ T1: "", T2: "x", T3: "0", T4: "0" }))).toEqual({ max: 10, perCell: 1 });
  });
});

describe("capBar with user-defined categories", () => {
  it("stacks any number of categories in list order, ids kept", () => {
    const bar = capBar(w({ T1: "10", visa: "4", T2: "8", tag: "0", remote: "2" }), "15");
    expect(bar.segments.map((s) => [s.id, s.value])).toEqual([
      ["T1", 10],
      ["visa", 4],
      ["T2", 8],
      ["tag", 0],
      ["remote", 2],
    ]);
    expect(bar).toMatchObject({ sum: 24, counted: 15, over: 9 });
  });

  it("is empty without categories", () => {
    expect(capBar([], "15")).toMatchObject({ sum: 0, counted: 0, segments: [] });
  });
});
