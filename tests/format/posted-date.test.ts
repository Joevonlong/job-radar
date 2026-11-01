import { describe, expect, it } from "vitest";

import { formatPostedAgo, formatPostedAgoShort, formatPostedDate, formatPostedFull, formatSeenAt, isDateOnly } from "@/lib/format/posted-date";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ZONES = ["Europe/Berlin", "America/New_York", "Asia/Shanghai"] as const;
const opts = (timeZone: string, locale: "en" | "zh") => ({ timeZone, locale });

describe("isDateOnly", () => {
  it("is true only for exactly UTC midnight", () => {
    expect(isDateOnly(new Date("2026-10-27T00:00:00.000Z"))).toBe(true);
    expect(isDateOnly(new Date("2026-10-27T00:00:00.001Z"))).toBe(false);
    expect(isDateOnly(new Date("2026-10-27T09:12:00Z"))).toBe(false);
  });
});

describe("formatPostedDate", () => {
  const NOW = new Date("2026-10-31T12:00:00Z");

  it.each(ZONES)("a date without a time keeps its UTC day in %s", (zone) => {
    const date = new Date("2026-10-27T00:00:00Z");
    expect(formatPostedDate(date, NOW, opts(zone, "en"))).toBe("Oct 27");
    expect(formatPostedDate(date, NOW, opts(zone, "zh"))).toBe("10/27");
  });

  it("a date with a time is read in the display zone", () => {
    const date = new Date("2026-10-27T23:30:00Z"); // 01:30 on the 28th in Berlin, 19:30 on the 27th in New York
    expect(formatPostedDate(date, NOW, opts("Europe/Berlin", "en"))).toBe("Oct 28");
    expect(formatPostedDate(date, NOW, opts("America/New_York", "en"))).toBe("Oct 27");
  });

  it("another year than now adds the year", () => {
    const date = new Date("2025-10-27T00:00:00Z");
    expect(formatPostedDate(date, NOW, opts("Europe/Berlin", "en"))).toBe("Oct 27, 2025");
    expect(formatPostedDate(date, NOW, opts("Europe/Berlin", "zh"))).toBe("2025/10/27");
  });

  it("adds the short weekday on request", () => {
    const date = new Date("2026-10-27T00:00:00Z"); // a Tuesday
    expect(formatPostedDate(date, NOW, opts("America/New_York", "en"), { weekday: true })).toBe("Oct 27 Tue");
    expect(formatPostedDate(date, NOW, opts("America/New_York", "zh"), { weekday: true })).toBe("10/27 周二");
  });
});

describe("formatPostedAgo", () => {
  const NOW = new Date("2026-10-31T12:00:00Z");
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
  const berlin = opts("Europe/Berlin", "en");

  it("a value with a time counts minutes and hours inside a day", () => {
    expect(formatPostedAgo(ago(10_000), NOW, berlin)).toBe("just now");
    expect(formatPostedAgo(ago(30 * MIN), NOW, berlin)).toBe("30 min ago");
    expect(formatPostedAgo(ago(5 * HOUR), NOW, berlin)).toBe("5 h ago");
    expect(formatPostedAgo(ago(30 * MIN), NOW, opts("Europe/Berlin", "zh"))).toBe("30 分钟前");
  });

  it("then counts calendar days in the display zone, never months", () => {
    expect(formatPostedAgo(ago(25 * HOUR), NOW, berlin)).toBe("yesterday");
    expect(formatPostedAgo(ago(4 * DAY), NOW, berlin)).toBe("4 days ago");
    expect(formatPostedAgo(ago(29 * DAY), NOW, berlin)).toBe("29 days ago");
    expect(formatPostedAgo(ago(200 * DAY), NOW, opts("Europe/Berlin", "zh"))).toBe("200 天前");
  });

  it("counts the day change in the display zone, not in UTC", () => {
    const date = new Date("2026-10-30T10:00:00Z"); // 26 h before NOW: the 30th in Berlin as well as in UTC
    expect(formatPostedAgo(date, NOW, opts("Europe/Berlin", "en"))).toBe("yesterday");
    const late = new Date("2026-10-31T23:30:00Z"); // 00:30 on Nov 1 in Berlin, still Oct 31 in UTC
    expect(formatPostedAgo(new Date("2026-10-30T20:00:00Z"), late, opts("Europe/Berlin", "en"))).toBe("2 days ago");
    expect(formatPostedAgo(new Date("2026-10-30T20:00:00Z"), late, opts("UTC", "en"))).toBe("yesterday");
  });

  it("the future is today, not a negative number", () => {
    expect(formatPostedAgo(new Date(NOW.getTime() + 3 * HOUR), NOW, berlin)).toBe("today");
    expect(formatPostedAgo(new Date("2026-11-03T00:00:00Z"), NOW, berlin)).toBe("today");
    expect(formatPostedAgo(new Date(NOW.getTime() + 3 * HOUR), NOW, opts("Europe/Berlin", "zh"))).toBe("今天");
  });

  describe("a date without a time", () => {
    it.each(ZONES)("never shows hours in %s", (zone) => {
      const text = formatPostedAgo(new Date("2026-10-27T00:00:00Z"), NOW, opts(zone, "en"));
      expect(text).not.toMatch(/\bh ago|min/u);
    });

    it("compares the UTC day with today in the display zone", () => {
      const date = new Date("2026-10-27T00:00:00Z");
      expect(formatPostedAgo(date, NOW, opts("Europe/Berlin", "en"))).toBe("4 days ago");
      expect(formatPostedAgo(date, NOW, opts("America/New_York", "en"))).toBe("4 days ago");
      expect(formatPostedAgo(date, NOW, opts("Asia/Shanghai", "zh"))).toBe("4 天前");
    });

    it("early on a Shanghai morning the source's day that is local today reads 'today'", () => {
      const early = new Date("2026-10-31T23:00:00Z"); // 07:00 on Nov 1 in Shanghai, still Oct 31 in UTC
      const sourceDay = new Date("2026-11-01T00:00:00Z");
      expect(formatPostedAgo(sourceDay, early, opts("Asia/Shanghai", "zh"))).toBe("今天");
      expect(formatPostedAgo(new Date("2026-10-31T00:00:00Z"), early, opts("Asia/Shanghai", "zh"))).toBe("昨天");
    });

    it("late evening in New York is already the next UTC day, but today is still New York's", () => {
      const late = new Date("2026-11-01T02:00:00Z"); // 22:00 on Oct 31 in New York (EDT ended Nov 1 06:00 UTC)
      expect(formatPostedAgo(new Date("2026-10-31T00:00:00Z"), late, opts("America/New_York", "en"))).toBe("today");
      expect(formatPostedAgo(new Date("2026-10-30T00:00:00Z"), late, opts("America/New_York", "en"))).toBe("yesterday");
    });
  });
});

describe("formatPostedFull", () => {
  it("a value with a time is written in the display zone with the zone's name", () => {
    const date = new Date("2026-10-27T13:05:00Z");
    expect(formatPostedFull(date, opts("Europe/Berlin", "en"))).toEqual({ text: "2026-10-27 14:05", zone: "Europe/Berlin", dateOnly: false });
    expect(formatPostedFull(date, opts("Asia/Shanghai", "zh"))).toEqual({ text: "2026-10-27 21:05", zone: "Asia/Shanghai", dateOnly: false });
  });

  it.each(ZONES)("a date without a time is the UTC day, without hours or zone, in %s", (zone) => {
    expect(formatPostedFull(new Date("2026-10-27T00:00:00Z"), opts(zone, "en"))).toEqual({ text: "2026-10-27", zone: null, dateOnly: true });
  });
});

describe("formatPostedAgoShort", () => {
  const NOW = new Date("2026-10-31T12:00:00Z");
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

  it("units without 'ago' for a column", () => {
    const en = opts("Europe/Berlin", "en");
    const zh = opts("Europe/Berlin", "zh");
    expect(formatPostedAgoShort(ago(30 * MIN), NOW, en)).toBe("30 min");
    expect(formatPostedAgoShort(ago(5 * HOUR), NOW, en)).toBe("5 h");
    expect(formatPostedAgoShort(ago(4 * DAY), NOW, en)).toBe("4 d");
    expect(formatPostedAgoShort(ago(4 * DAY), NOW, zh)).toBe("4 天");
    expect(formatPostedAgoShort(ago(25 * HOUR), NOW, zh)).toBe("昨天");
    expect(formatPostedAgoShort(new Date("2026-10-31T00:00:00Z"), NOW, zh)).toBe("今天");
  });
});

describe("formatSeenAt", () => {
  it("our own timestamp to the minute in the display zone, even at UTC midnight", () => {
    const now = new Date("2026-10-31T12:00:00Z");
    expect(formatSeenAt(new Date("2026-10-27T08:12:00Z"), now, opts("Europe/Berlin", "zh"))).toBe("10/27 09:12");
    expect(formatSeenAt(new Date("2026-10-27T00:00:00Z"), now, opts("America/New_York", "en"))).toBe("Oct 26 20:00");
  });
});
