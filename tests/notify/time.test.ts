import { describe, expect, it } from "vitest";

import { clockMinutes, formatLocalShort, isQuietHours, isReminderDue, localDate } from "@/lib/notify/time";

const TZ = "Europe/Berlin";
const quiet = { enabled: true, start: "22:00", end: "07:00" };

/** An instant given as Berlin wall-clock time (CEST, UTC+2, in October before the 25th). */
const berlin = (isoLocal: string): Date => new Date(`${isoLocal}:00+02:00`);

describe("isQuietHours", () => {
  it("covers the window across midnight, start inclusive and end exclusive", () => {
    expect(isQuietHours(berlin("2026-10-07T21:59"), TZ, quiet)).toBe(false);
    expect(isQuietHours(berlin("2026-10-07T22:00"), TZ, quiet)).toBe(true);
    expect(isQuietHours(berlin("2026-10-07T23:59"), TZ, quiet)).toBe(true);
    expect(isQuietHours(berlin("2026-10-08T00:00"), TZ, quiet)).toBe(true);
    expect(isQuietHours(berlin("2026-10-08T06:59"), TZ, quiet)).toBe(true);
    expect(isQuietHours(berlin("2026-10-08T07:00"), TZ, quiet)).toBe(false);
    expect(isQuietHours(berlin("2026-10-08T12:00"), TZ, quiet)).toBe(false);
  });

  it("reads the time in the configured zone, not UTC", () => {
    // 21:30 UTC is 23:30 in Berlin (inside 22:00-07:00); the same instant is 21:30 in UTC (outside 23:00-07:00)
    expect(isQuietHours(new Date("2026-10-07T21:30:00Z"), TZ, quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-10-07T21:30:00Z"), "UTC", { enabled: true, start: "23:00", end: "07:00" })).toBe(false);
  });

  it("handles a same-day window and an empty one", () => {
    const day = { enabled: true, start: "13:00", end: "15:00" };
    expect(isQuietHours(berlin("2026-10-07T14:00"), TZ, day)).toBe(true);
    expect(isQuietHours(berlin("2026-10-07T15:00"), TZ, day)).toBe(false);
    expect(isQuietHours(berlin("2026-10-07T03:00"), TZ, { enabled: true, start: "08:00", end: "08:00" })).toBe(false);
  });

  it("is never quiet when disabled", () => {
    expect(isQuietHours(berlin("2026-10-07T23:00"), TZ, { ...quiet, enabled: false })).toBe(false);
  });

  it("follows daylight saving time", () => {
    // clocks go back on 2026-10-25: Berlin is UTC+2 before and UTC+1 after the switch
    expect(isQuietHours(new Date("2026-10-25T21:30:00Z"), TZ, quiet)).toBe(true); // 22:30 CET
    expect(isQuietHours(new Date("2026-10-25T20:30:00Z"), TZ, quiet)).toBe(false); // 21:30 CET
    expect(isQuietHours(new Date("2026-10-26T05:59:00Z"), TZ, quiet)).toBe(true); // 06:59 CET
    expect(isQuietHours(new Date("2026-10-26T06:00:00Z"), TZ, quiet)).toBe(false); // 07:00 CET
  });
});

describe("isReminderDue", () => {
  const base = { timeZone: TZ, sendAt: "09:00" };

  it("is due from the send time on when nothing was handled today", () => {
    expect(isReminderDue({ ...base, now: berlin("2026-10-07T08:59"), lastHandledAt: null })).toBe(false);
    expect(isReminderDue({ ...base, now: berlin("2026-10-07T09:00"), lastHandledAt: null })).toBe(true);
    expect(isReminderDue({ ...base, now: berlin("2026-10-07T18:00"), lastHandledAt: berlin("2026-10-06T09:00") })).toBe(true);
  });

  it("is not due again on the same local day", () => {
    expect(isReminderDue({ ...base, now: berlin("2026-10-07T15:00"), lastHandledAt: berlin("2026-10-07T09:01") })).toBe(false);
  });

  it("compares local dates, not UTC dates", () => {
    // 22:30Z on the 7th is already 00:30 on the 8th in Berlin (same local day as the reminder), though still the 7th in UTC
    expect(isReminderDue({ ...base, now: berlin("2026-10-08T09:30"), lastHandledAt: new Date("2026-10-07T22:30:00Z") })).toBe(false); // 00:30 Berlin on the 8th
    expect(isReminderDue({ ...base, now: berlin("2026-10-08T09:30"), lastHandledAt: new Date("2026-10-07T21:30:00Z") })).toBe(true); // 23:30 Berlin on the 7th
  });
});

describe("helpers", () => {
  it("parses clock times and formats local dates", () => {
    expect(clockMinutes("07:05")).toBe(425);
    expect(localDate(new Date("2026-10-07T22:30:00Z"), TZ)).toBe("2026-10-08");
    expect(formatLocalShort(new Date("2026-10-07T05:00:00Z"), TZ)).toBe("10-07 07:00");
    expect(formatLocalShort(new Date("2026-10-07T22:05:00Z"), TZ)).toBe("10-08 00:05");
  });
});
