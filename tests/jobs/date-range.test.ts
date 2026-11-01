import { describe, expect, it } from "vitest";

import { dateRangeChoice, displayedDateField, effectiveDateRange, formatWithin, hasDateCondition, parseWithin, WITHIN_MAX_DAYS } from "@/lib/jobs/date-range";

describe("parseWithin", () => {
  it("reads Nd for N from 1 to the cap, and month", () => {
    expect(parseWithin("1d")).toEqual({ kind: "days", days: 1 });
    expect(parseWithin("7d")).toEqual({ kind: "days", days: 7 });
    expect(parseWithin(`${WITHIN_MAX_DAYS}d`)).toEqual({ kind: "days", days: WITHIN_MAX_DAYS });
    expect(parseWithin("month")).toEqual({ kind: "month" });
  });

  it.each(["0d", "00d", "07d", "367d", "1000d", "7", "7D", "d", "-1d", "1.5d", "Month", "foo", ""])("rejects %j", (value) => {
    expect(parseWithin(value)).toBeNull();
  });

  it("formats back to the token it was read from", () => {
    for (const token of ["1d", "14d", "366d", "month"]) expect(formatWithin(parseWithin(token)!)).toBe(token);
  });
});

describe("effectiveDateRange", () => {
  const within = parseWithin("7d");

  it("reads a hand-written from after to as the span between the two dates", () => {
    expect(effectiveDateRange({ from: "2026-10-15", to: "2026-10-01", dateBy: "posted" })).toEqual({ within: null, from: "2026-10-01", to: "2026-10-15", dateField: "posted" });
    expect(effectiveDateRange({ from: "2026-10-01", to: "2026-10-01" })).toMatchObject({ from: "2026-10-01", to: "2026-10-01" });
    expect(effectiveDateRange({ from: "2026-10-01", to: "2026-10-15" })).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
  });

  it("says nothing without a date condition, even with a bare dateBy", () => {
    expect(effectiveDateRange({})).toEqual({ within: null, from: null, to: null, dateField: null });
    expect(effectiveDateRange({ dateBy: "posted" })).toEqual({ within: null, from: null, to: null, dateField: null });
    expect(hasDateCondition({ dateBy: "seen" })).toBe(false);
  });

  it("reads dates without dateBy as first seen (old links, saved views)", () => {
    expect(effectiveDateRange({ from: "2026-10-01", to: "2026-10-15" })).toEqual({ within: null, from: "2026-10-01", to: "2026-10-15", dateField: "seen" });
    expect(effectiveDateRange({ from: "2026-10-01", dateBy: "posted" }).dateField).toBe("posted");
  });

  it("lets within win over from / to, and defaults a range's date to first seen like the dates", () => {
    expect(effectiveDateRange({ within, from: "2026-10-01", to: "2026-10-15", dateBy: "posted" })).toEqual({ within, from: null, to: null, dateField: "posted" });
    expect(effectiveDateRange({ within }).dateField).toBe("seen");
  });
});

describe("what the filter bar shows", () => {
  it("shows the configured date until the URL says one, and first seen for an old dates link", () => {
    expect(displayedDateField({}, "posted")).toBe("posted");
    expect(displayedDateField({}, "seen")).toBe("seen");
    expect(displayedDateField({ from: "2026-10-01" }, "posted")).toBe("seen");
    expect(displayedDateField({ from: "2026-10-01", dateBy: "posted" }, "seen")).toBe("posted");
    expect(displayedDateField({ dateBy: "seen" }, "posted")).toBe("seen");
  });

  it("selects the quick range, custom or any", () => {
    expect(dateRangeChoice({})).toEqual({ kind: "any" });
    expect(dateRangeChoice({ dateBy: "posted" })).toEqual({ kind: "any" });
    expect(dateRangeChoice({ from: "2026-10-01" })).toEqual({ kind: "custom" });
    expect(dateRangeChoice({ to: "2026-10-01" })).toEqual({ kind: "custom" });
    expect(dateRangeChoice({ within: parseWithin("month"), from: "2026-10-01" })).toEqual({ kind: "within", within: { kind: "month" } });
  });
});
