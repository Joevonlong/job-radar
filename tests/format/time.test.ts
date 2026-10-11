import { describe, expect, it } from "vitest";

import { formatDuration, formatFullTime, formatRelativeTime, formatShortDate, toDate } from "@/lib/format/time";

const NOW = new Date("2026-10-08T12:00:00Z"); // 14:00 in Berlin
const TZ = { timeZone: "Europe/Berlin", locale: "zh" } as const;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("formatRelativeTime (zh)", () => {
  it.each([
    [0, "刚刚"],
    [30_000, "刚刚"],
    [MIN, "1 分钟前"],
    [5 * MIN, "5 分钟前"],
    [59 * MIN, "59 分钟前"],
    [HOUR, "1 小时前"],
    [5 * HOUR, "5 小时前"],
    [13 * HOUR, "13 小时前"],
    [14 * HOUR + 30 * MIN, "14 小时前"], // 23:30 yesterday, but under 24 h: still hours
    [23 * HOUR + 59 * MIN, "23 小时前"],
  ])("%s ms ago -> %s", (elapsed, expected) => {
    expect(formatRelativeTime(ago(elapsed), NOW, TZ)).toBe(expected);
  });

  it("yesterday is the previous calendar day once 24 hours have passed", () => {
    expect(formatRelativeTime(ago(25 * HOUR), NOW, TZ)).toBe("昨天");
    expect(formatRelativeTime(ago(36 * HOUR), NOW, TZ)).toBe("昨天");
    expect(formatRelativeTime(ago(24 * HOUR), NOW, TZ)).toBe("昨天");
  });

  it("older than yesterday is a date, 10/05 style", () => {
    expect(formatRelativeTime(new Date("2026-10-05T09:00:00Z"), NOW, TZ)).toBe("10/05");
    expect(formatRelativeTime(new Date("2026-01-02T09:00:00Z"), NOW, TZ)).toBe("01/02");
  });

  it("another year includes the year", () => {
    expect(formatRelativeTime(new Date("2025-12-31T09:00:00Z"), NOW, TZ)).toBe("2025/12/31");
  });

  it("counts the calendar day in the given zone", () => {
    // 23:30 UTC on Oct 6 is 01:30 on Oct 7 in Berlin: "yesterday" relative to Oct 8 there, but Oct 6 in UTC.
    const t = new Date("2026-10-06T23:30:00Z");
    expect(formatRelativeTime(t, NOW, TZ)).toBe("昨天");
    expect(formatRelativeTime(t, NOW, { timeZone: "UTC", locale: "zh" })).toBe("10/06");
  });

  it("the future (clock skew) is just now", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 5 * MIN), NOW, TZ)).toBe("刚刚");
  });

  it("never writes fractional days", () => {
    expect(formatRelativeTime(ago(5 * HOUR), NOW, TZ)).not.toMatch(/天前|0\./);
  });

  it("accepts ISO strings and timestamps; unknown is —", () => {
    expect(formatRelativeTime("2026-10-08T07:00:00Z", NOW, TZ)).toBe("5 小时前");
    expect(formatRelativeTime(ago(2 * HOUR).getTime(), NOW, TZ)).toBe("2 小时前");
    expect(formatRelativeTime(null, NOW, { locale: "zh" })).toBe("—");
    expect(formatRelativeTime("not a date", NOW, { locale: "zh" })).toBe("—");
    expect(formatRelativeTime("", NOW, { locale: "zh" })).toBe("—");
  });
});

describe("formatRelativeTime (en)", () => {
  const en = { ...TZ, locale: "en" as const };
  it.each([
    [10_000, "just now"],
    [5 * MIN, "5 min ago"],
    [5 * HOUR, "5 h ago"],
    [25 * HOUR, "yesterday"],
  ])("%s ms ago -> %s", (elapsed, expected) => {
    expect(formatRelativeTime(ago(elapsed), NOW, en)).toBe(expected);
  });
  it("dates read Oct 5", () => {
    expect(formatRelativeTime(new Date("2026-10-05T09:00:00Z"), NOW, en)).toBe("Oct 5");
    expect(formatRelativeTime(new Date("2025-10-05T09:00:00Z"), NOW, en)).toBe("Oct 5, 2025");
  });
});

describe("formatShortDate / formatFullTime / toDate", () => {
  it("short date", () => {
    expect(formatShortDate(new Date("2026-03-09T10:00:00Z"), NOW, TZ)).toBe("03/09");
  });
  it("full time for the tooltip", () => {
    expect(formatFullTime("2026-10-05T15:38:00Z", TZ)).toBe("2026-10-05 17:38");
    expect(formatFullTime(null, { locale: "zh" })).toBe("—");
  });
  it("toDate rejects junk", () => {
    expect(toDate(undefined)).toBeNull();
    expect(toDate("x")).toBeNull();
    expect(toDate(NOW)).toBe(NOW);
  });
});

describe("formatDuration", () => {
  const day = 24 * HOUR;
  it.each([
    [16 * day, "16 天"],
    [day + 4 * HOUR, "1 天 4 小时"],
    [3 * HOUR + 20 * MIN, "3 小时 20 分钟"],
    [2 * HOUR, "2 小时"],
    [3 * MIN, "3 分钟"],
    [45_000, "45 秒"],
    [200, "<1 分钟"],
    [0, "<1 分钟"],
    [16 * day + 5 * HOUR + 7 * MIN, "16 天 5 小时"], // at most two units
  ])("%s ms -> %s", (ms, expected) => {
    expect(formatDuration(ms, "zh")).toBe(expected);
  });

  it("never 384h", () => {
    expect(formatDuration(16 * day, "zh")).not.toMatch(/\d+h$/);
  });

  it("English units", () => {
    expect(formatDuration(16 * day, "en")).toBe("16 d");
    expect(formatDuration(3 * MIN, "en")).toBe("3 min");
    expect(formatDuration(day + 4 * HOUR, "en")).toBe("1 d 4 h");
  });

  it("unknown or negative is —", () => {
    expect(formatDuration(null, "zh")).toBe("—");
    expect(formatDuration(-5, "zh")).toBe("—");
    expect(formatDuration(Number.NaN, "zh")).toBe("—");
  });
});
