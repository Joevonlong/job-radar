import { describe, expect, it } from "vitest";
import { activitySearchSchema, activityHref, resolveActivityRange } from "@/lib/activity/search";

describe("activity URL state", () => {
  it("rejects arrays, arbitrary codes and invalid ids without passing them to queries or links", () => {
    const state = activitySearchSchema.parse({ type: ["cycle", "system"], status: "secret", cycle: "-2", page: "1.5", level: "secret", from: "2026-02-30" });
    expect(state).toMatchObject({ type: "all", status: "all", cycle: undefined, page: 1, level: "all", from: undefined });
    expect(activityHref(state)).toBe("/sources/logs");
  });
  it("retains validated filters while paging, and isolates detail level filters", () => {
    const state = activitySearchSchema.parse({ type: "cycle", status: "failed", range: "custom", from: "2026-10-01", to: "2026-10-29", issues: "1", level: "warn", page: "2" });
    expect(activityHref(state, { page: 3 })).toBe("/sources/logs?type=cycle&status=failed&range=custom&from=2026-10-01&to=2026-10-29&issues=1&page=3");
    expect(activityHref(state, {}, "/sources/logs/entry")).toBe("/sources/logs/entry?level=warn&page=2");
  });
  it("uses inclusive calendar days across daylight-saving boundaries", () => {
    const state = activitySearchSchema.parse({ range: "custom", from: "2026-10-25", to: "2026-10-25" });
    const range = resolveActivityRange(state, "2026-10-29", 11, "Europe/Berlin");
    expect(range.fromInstant.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(range.toInstant.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
  it("uses the supplied default duration and safely resets reversed custom dates", () => {
    const state = activitySearchSchema.parse({ range: "custom", from: "2026-10-29", to: "2026-10-01" });
    expect(resolveActivityRange(state, "2026-10-29", 11, "UTC")).toMatchObject({ from: "2026-10-19", to: "2026-10-29" });
    expect(resolveActivityRange(activitySearchSchema.parse({ range: "today" }), "2026-10-29", 11, "UTC")).toMatchObject({ from: "2026-10-29", to: "2026-10-29" });
  });
});
