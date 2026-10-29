// @vitest-environment node
import { describe, expect, it } from "vitest";

import { postedDateEnd, postedDateEvidence } from "@/lib/channels/linkedin/date-window";

describe("shared posted date evidence", () => {
  it.each([
    { name: "missing", value: null, postedAt: null, end: null, flags: ["date_missing"] },
    { name: "unparsed", value: "not a date", postedAt: null, end: null, flags: ["date_unparsed"] },
    { name: "invalid calendar date", value: "2026-02-30", postedAt: null, end: null, flags: ["date_unparsed"] },
    { name: "bare date", value: "2026-10-26", postedAt: new Date("2026-10-26T00:00:00Z"), end: Date.parse("2026-10-27T00:00:00Z"), flags: ["date_day_precision"] },
    { name: "padded bare date", value: " 2026-10-26 ", postedAt: new Date("2026-10-26T00:00:00Z"), end: Date.parse("2026-10-27T00:00:00Z"), flags: ["date_day_precision"] },
    { name: "instant", value: "2026-10-26T08:30:00Z", postedAt: new Date("2026-10-26T08:30:00Z"), end: Date.parse("2026-10-26T08:30:00Z"), flags: [] },
    { name: "midnight instant", value: "2026-10-26T00:00:00Z", postedAt: new Date("2026-10-26T00:00:00Z"), end: Date.parse("2026-10-26T00:00:00Z"), flags: [] },
  ])("reports $name precision and preserves the old window end", ({ value, postedAt, end, flags }) => {
    expect(postedDateEvidence(value, postedAt)).toEqual({ end, flags });
    expect(postedDateEnd(value, postedAt)).toBe(end);
  });
});
