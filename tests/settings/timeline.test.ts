import { describe, expect, it } from "vitest";

import { clockText, clockToMinutes, cronSlots, dayPercent, describeCron, minutesNow, quietSegments, timelineRuns } from "@/lib/settings/timeline";

describe("cronSlots", () => {
  it("reads the minutes, hours and weekdays of a cron", () => {
    expect(cronSlots("0 7 * * 1-5")).toEqual({ minutes: [420], kind: "weekday" });
    expect(cronSlots("0 9 * * 0,6")).toEqual({ minutes: [540], kind: "weekend" });
    expect(cronSlots("30 7,17 * * *")).toEqual({ minutes: [450, 1050], kind: "daily" });
    expect(cronSlots("*/30 8 * * MON")).toEqual({ minutes: [480, 510], kind: "weekday" });
  });

  it("treats 7 as Sunday and reports nothing for an invalid cron", () => {
    expect(cronSlots("0 10 * * 7")?.kind).toBe("weekend");
    expect(cronSlots("nonsense")).toBeNull();
    expect(cronSlots("0 7 * *")).toBeNull();
    expect(cronSlots("")).toBeNull();
  });
});

describe("timelineRuns", () => {
  const cycles = [
    { id: "weekday_morning", cron: "0 7 * * 1-5", enabled: true },
    { id: "weekday_evening", cron: "0 17 * * 1-5", enabled: true },
    { id: "weekend", cron: "0 9 * * 0,6", enabled: true },
  ];

  it("lists the slots of the enabled cycles in time order", () => {
    expect(timelineRuns(cycles).map((run) => `${run.id}@${clockText(run.minutes)}:${run.kind}`)).toEqual(["weekday_morning@07:00:weekday", "weekend@09:00:weekend", "weekday_evening@17:00:weekday"]);
  });

  it("keeps a disabled cycle's slots, marked off, and leaves out one whose cron does not parse (it is being typed)", () => {
    const edited = [{ ...cycles[0]!, enabled: false }, { ...cycles[1]!, cron: "0 17 *" }, cycles[2]!];
    expect(timelineRuns(edited).map((run) => `${run.id}:${run.enabled}`)).toEqual(["weekday_morning:false", "weekend:true"]);
  });

  it("describes a cron in words: the kind of days and the times", () => {
    expect(describeCron("0 7 * * 1-5")).toEqual({ kind: "weekday", times: ["07:00"] });
    expect(describeCron("30 9 * * 0,6")).toEqual({ kind: "weekend", times: ["09:30"] });
    expect(describeCron("0 8,18 * * *")).toEqual({ kind: "daily", times: ["08:00", "18:00"] });
    expect(describeCron("0 7 *")).toBeNull();
  });
});

describe("quietSegments", () => {
  it("splits a window that crosses midnight in two", () => {
    expect(quietSegments({ enabled: true, start: "22:00", end: "07:00" })).toEqual([
      { from: 0, to: 420 },
      { from: 1320, to: 1440 },
    ]);
  });

  it("keeps a same-day window whole and ignores an empty, disabled or malformed one", () => {
    expect(quietSegments({ enabled: true, start: "13:00", end: "14:30" })).toEqual([{ from: 780, to: 870 }]);
    expect(quietSegments({ enabled: true, start: "07:00", end: "07:00" })).toEqual([]);
    expect(quietSegments({ enabled: false, start: "22:00", end: "07:00" })).toEqual([]);
    expect(quietSegments({ enabled: true, start: "25:00", end: "07:00" })).toEqual([]);
    expect(quietSegments(null)).toEqual([]);
  });
});

describe("minutesNow", () => {
  it("is the local time of the schedule's zone, not the runtime's", () => {
    const instant = new Date("2026-10-08T16:04:00Z");
    expect(minutesNow(instant, "Europe/Berlin")).toBe(18 * 60 + 4); // CEST, UTC+2
    expect(minutesNow(instant, "UTC")).toBe(16 * 60 + 4);
    expect(minutesNow(instant, "Asia/Shanghai")).toBe(0 * 60 + 4);
    // winter: UTC+1
    expect(minutesNow(new Date("2026-01-15T16:04:00Z"), "Europe/Berlin")).toBe(17 * 60 + 4);
  });

  it("is null for a zone name that does not exist", () => {
    expect(minutesNow(new Date(), "Mars/Olympus")).toBeNull();
  });
});

describe("axis helpers", () => {
  it("maps minutes to a share of the 24 h axis", () => {
    expect(dayPercent(0)).toBe(0);
    expect(dayPercent(420)).toBeCloseTo(29.17, 2);
    expect(dayPercent(1440)).toBe(100);
    expect(dayPercent(2000)).toBe(100);
    expect(clockToMinutes("07:05")).toBe(425);
    expect(clockToMinutes("7:05")).toBeNull();
    expect(clockText(1440)).toBe("24:00");
  });
});
