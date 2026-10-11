import { describe, expect, it } from "vitest";

import { BOARD_COLUMNS, CLOCK_SCALE, clockBar, columnOfStatus, ENDED_STATUSES, freshClockOf, countInPipeline, isEndedStatus, isInPipeline, PIPELINE_STATUSES, nextActionDateToTimestamp, overdueOf, overdueThresholds, stageClockOf, timestampToNextActionDate } from "@/lib/dashboard/board";
import { parseConfigText, readConfigText } from "@/lib/config";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";

const DAY_MS = 86_400_000;
const thresholds = { interestedDays: 7, appliedDays: 14 };
const now = new Date("2026-10-07T12:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(now.getTime() - days * DAY_MS - extraMs);

describe("columns", () => {
  it("puts every status in exactly one column, and the three end states together", () => {
    for (const status of APPLICATION_STATUSES) expect(BOARD_COLUMNS).toContain(columnOfStatus(status));
    expect(columnOfStatus("new")).toBe("new");
    expect(columnOfStatus("interviewing")).toBe("interviewing");
    for (const status of ENDED_STATUSES) {
      expect(columnOfStatus(status)).toBe("ended");
      expect(isEndedStatus(status)).toBe(true);
    }
    expect(isEndedStatus("offer")).toBe(false);
  });

  it("has one column per active status plus ended", () => {
    expect(BOARD_COLUMNS).toHaveLength(APPLICATION_STATUSES.length - ENDED_STATUSES.length + 1);
  });
});

describe("the pipeline set", () => {
  it("is every status that is not ended, `new` included", () => {
    expect([...PIPELINE_STATUSES].sort()).toEqual(APPLICATION_STATUSES.filter((status) => !isEndedStatus(status)).sort());
    expect(isInPipeline("new")).toBe(true);
    expect(isInPipeline("offer")).toBe(true);
    expect(isInPipeline("rejected")).toBe(false);
  });

  it("counts 6 / 5 / 4 for the seed shape: title and shares agree, the badge is the same set", () => {
    const board = (["new", "interested", "applied", "applied", "interviewing", "rejected"] as const).map((status) => ({ status }));
    expect(board).toHaveLength(6);
    expect(countInPipeline(board)).toBe(5);
    // a board whose only card is `new` is a board with one job in the pipeline (not "0 jobs while the first column holds a card at 100%")
    expect(countInPipeline([{ status: "new" }])).toBe(1);
    expect(countInPipeline([])).toBe(0);
  });
});

describe("overdueOf", () => {
  it("flags interested after more than N days and applied after more than M days", () => {
    expect(overdueOf("interested", ago(9), now, thresholds)).toEqual({ kind: "interested", days: 9 });
    expect(overdueOf("applied", ago(16, 3600_000), now, thresholds)).toEqual({ kind: "applied", days: 16 });
  });

  it("is strictly longer than the threshold, like the Telegram reminder", () => {
    expect(overdueOf("interested", ago(7), now, thresholds)).toBeNull();
    expect(overdueOf("interested", ago(7, 1), now, thresholds)).toEqual({ kind: "interested", days: 7 });
    expect(overdueOf("applied", ago(14), now, thresholds)).toBeNull();
  });

  it("follows the thresholds it is given (notify.yaml)", () => {
    expect(overdueOf("interested", ago(3), now, { interestedDays: 2, appliedDays: 14 })).toEqual({ kind: "interested", days: 3 });
    expect(overdueOf("interested", ago(9), now, { interestedDays: 30, appliedDays: 14 })).toBeNull();
    expect(overdueOf("applied", ago(10), now, { interestedDays: 7, appliedDays: 5 })).toEqual({ kind: "applied", days: 10 });
  });

  it("never flags the other statuses", () => {
    for (const status of APPLICATION_STATUSES.filter((s) => s !== "interested" && s !== "applied")) {
      expect(overdueOf(status, ago(400), now, thresholds)).toBeNull();
    }
  });
});

describe("stageClockOf", () => {
  it("returns the whole days in the status next to the threshold, overdue or not", () => {
    expect(stageClockOf("interested", ago(2), now, thresholds)).toEqual({ kind: "interested", days: 2, limitDays: 7 });
    expect(stageClockOf("applied", ago(16, 3600_000), now, thresholds)).toEqual({ kind: "applied", days: 16, limitDays: 14 });
  });

  it("agrees with overdueOf on the day count", () => {
    for (const status of ["interested", "applied"] as const) {
      const over = overdueOf(status, ago(20), now, thresholds);
      expect(over?.days).toBe(stageClockOf(status, ago(20), now, thresholds)?.days);
    }
  });

  it("follows the thresholds it is given and is null for statuses without a clock", () => {
    expect(stageClockOf("applied", ago(3), now, { interestedDays: 7, appliedDays: 5 })?.limitDays).toBe(5);
    for (const status of APPLICATION_STATUSES.filter((s) => s !== "interested" && s !== "applied")) {
      expect(stageClockOf(status, ago(3), now, thresholds)).toBeNull();
    }
  });

  it("never goes negative when the clock is ahead of the server", () => {
    expect(stageClockOf("interested", new Date(now.getTime() + DAY_MS), now, thresholds)?.days).toBe(0);
  });

  it("starts a fresh clock at 0 days", () => {
    expect(freshClockOf("interested", thresholds)).toEqual({ kind: "interested", days: 0, limitDays: 7 });
    expect(freshClockOf("offer", thresholds)).toBeNull();
  });
});

describe("clockBar", () => {
  it("puts the threshold tick at 1/CLOCK_SCALE of the track and the fill in proportion", () => {
    const tick = 100 / CLOCK_SCALE;
    expect(clockBar({ kind: "interested", days: 0, limitDays: 7 })).toEqual({ fill: 0, tick });
    // exactly at the threshold the fill reaches the tick
    expect(clockBar({ kind: "interested", days: 7, limitDays: 7 }).fill).toBeCloseTo(tick);
    expect(clockBar({ kind: "applied", days: 10, limitDays: 14 }).fill).toBeLessThan(tick);
  });

  it("stops at the end of the track", () => {
    expect(clockBar({ kind: "applied", days: 400, limitDays: 14 }).fill).toBe(100);
  });
});

describe("next-step date", () => {
  it("round-trips a calendar day regardless of time zone", () => {
    const stored = nextActionDateToTimestamp("2026-12-24");
    expect(stored?.toISOString()).toBe("2026-12-24T12:00:00.000Z");
    expect(stored ? timestampToNextActionDate(stored) : null).toBe("2026-12-24");
  });

  it("rejects text that is not a real date", () => {
    expect(nextActionDateToTimestamp("2026-02-30")).toBeNull();
    expect(nextActionDateToTimestamp("tomorrow")).toBeNull();
    expect(nextActionDateToTimestamp("")).toBeNull();
  });
});

describe("overdueThresholds", () => {
  it("reads the reminder days of notify.yaml, so editing the file changes what is overdue", () => {
    const shipped = readConfigText("notify");
    const before = overdueThresholds(parseConfigText("notify", shipped));
    expect(before).toEqual({ interestedDays: 7, appliedDays: 14 });
    expect(overdueOf("interested", ago(9), now, before)).not.toBeNull();

    const edited = shipped.replace(/interested_days: 7/, "interested_days: 10").replace(/applied_days: 14/, "applied_days: 20");
    expect(edited).not.toBe(shipped);
    const after = overdueThresholds(parseConfigText("notify", edited));
    expect(after).toEqual({ interestedDays: 10, appliedDays: 20 });
    expect(overdueOf("interested", ago(9), now, after)).toBeNull();
    expect(overdueOf("applied", ago(16), now, after)).toBeNull();
    expect(overdueOf("applied", ago(21), now, after)).toEqual({ kind: "applied", days: 21 });
  });
});
