// @vitest-environment node
import { describe, expect, it } from "vitest";

import { daysBetween, isDay, resolveAiUsageRange, type RangeParams } from "@/lib/ai-usage/range";

const options = (today: string) => ({ today, defaultRange: "30d" as const, customMaxDays: 366 });
const params = (p: Partial<RangeParams>): RangeParams => ({ range: null, from: null, to: null, ...p });

describe("resolveAiUsageRange", () => {
  it("resolves the fixed ranges, today included", () => {
    expect(resolveAiUsageRange(params({ range: "today" }), options("2026-10-08"))).toMatchObject({ from: "2026-10-08", to: "2026-10-08", days: 1 });
    expect(resolveAiUsageRange(params({ range: "7d" }), options("2026-10-08"))).toMatchObject({ from: "2026-10-02", to: "2026-10-08", days: 7 });
    expect(resolveAiUsageRange(params({ range: "30d" }), options("2026-10-08"))).toMatchObject({ from: "2026-09-09", to: "2026-10-08", days: 30 });
  });
  it("this month starts on the 1st (also on the 1st itself and across a leap February)", () => {
    expect(resolveAiUsageRange(params({ range: "month" }), options("2026-10-08"))).toMatchObject({ from: "2026-10-01", days: 8 });
    expect(resolveAiUsageRange(params({ range: "month" }), options("2026-10-01"))).toMatchObject({ from: "2026-10-01", to: "2026-10-01", days: 1 });
    expect(resolveAiUsageRange(params({ range: "30d" }), options("2028-03-10"))).toMatchObject({ from: "2028-02-10", days: 30 });
    expect(resolveAiUsageRange(params({ range: "7d" }), options("2028-03-03"))).toMatchObject({ from: "2028-02-26" });
  });
  it("uses the default for no / unknown range without a warning", () => {
    expect(resolveAiUsageRange(params({}), options("2026-10-08"))).toMatchObject({ kind: "30d", invalid: false });
  });
  it("accepts a valid custom range", () => {
    expect(resolveAiUsageRange(params({ range: "custom", from: "2026-09-01", to: "2026-09-15" }), options("2026-10-08"))).toMatchObject({ kind: "custom", from: "2026-09-01", to: "2026-09-15", days: 15, invalid: false });
  });
  it.each([
    ["missing dates", { from: null, to: null }],
    ["bad format", { from: "2026-9-1", to: "2026-09-15" }],
    ["impossible day", { from: "2026-02-30", to: "2026-03-05" }],
    ["from after to", { from: "2026-09-15", to: "2026-09-01" }],
    ["to in the future", { from: "2026-10-01", to: "2026-10-09" }],
    ["too long", { from: "2024-01-01", to: "2026-10-08" }],
  ])("falls back to the default and flags %s", (_name, dates) => {
    const result = resolveAiUsageRange(params({ range: "custom", ...dates }), options("2026-10-08"));
    expect(result).toMatchObject({ kind: "30d", from: "2026-09-09", to: "2026-10-08", invalid: true });
  });
});

describe("day helpers", () => {
  it("validates real calendar days", () => {
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay(null)).toBe(false);
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(1);
  });
});
