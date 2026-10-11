import { describe, expect, it } from "vitest";

import { changedPaths } from "@/lib/draft-diff";

describe("changedPaths", () => {
  it("lists the fields that differ, by dotted path", () => {
    const initial = { timezone: "Europe/Berlin", "cycles.weekend.cron": "0 9 * * 0,6", catch_up: true };
    expect(changedPaths(initial, initial)).toEqual([]);
    expect(changedPaths({ ...initial, "cycles.weekend.cron": "0 10 * * 0,6", catch_up: false }, initial).sort()).toEqual(["catch_up", "cycles.weekend.cron"]);
  });

  it("walks nested records and counts a changed list once", () => {
    const initial = { weights: { T1: "10", T2: "8" }, T2: { keywords: ["equity", "ESOP"], patterns: [] as string[] } };
    const current = { weights: { T1: "10", T2: "9" }, T2: { keywords: ["equity", "ESOP", "RSU", "VSOP"], patterns: [] as string[] } };
    expect(changedPaths(current, initial).sort()).toEqual(["T2.keywords", "weights.T2"]);
  });

  it("sees a key that exists on one side only", () => {
    expect(changedPaths({ a: "1" }, {})).toEqual(["a"]);
    expect(changedPaths({}, { a: "1" })).toEqual(["a"]);
  });
});
