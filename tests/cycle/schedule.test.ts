// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import type { ScheduleConfig } from "@/lib/config";
import { createScheduler, findMissedCycle, formatSlot, latestSlotAtOrBefore, missedCycle } from "@/lib/cycle/schedule";

import { shippedSchedule } from "../channels/helpers";

const TZ = "Europe/Berlin";
const schedule = shippedSchedule();

/** A UTC instant from a Berlin wall-clock time given as "YYYY-MM-DDTHH:mm" with the UTC offset in hours. */
const berlin = (local: string, offsetHours: 1 | 2): Date =>
  new Date(`${local}${local.length === 16 ? ":00" : ""}${offsetHours === 2 ? "+02:00" : "+01:00"}`);
const summer = (local: string): Date => berlin(local, 2);
const winter = (local: string): Date => berlin(local, 1);

function withCycles(overrides: Partial<Record<keyof ScheduleConfig["cycles"], { cron?: string; enabled?: boolean }>>): ScheduleConfig {
  return {
    ...schedule,
    cycles: {
      weekday_morning: { ...schedule.cycles.weekday_morning, ...overrides.weekday_morning },
      weekday_evening: { ...schedule.cycles.weekday_evening, ...overrides.weekday_evening },
      weekend: { ...schedule.cycles.weekend, ...overrides.weekend },
    },
  };
}

describe("missedCycle: weekdays", () => {
  // 2026-10-07 is a Wednesday
  it("returns the morning cycle when it was due and nothing ran since", () => {
    expect(missedCycle(summer("2026-10-07T08:00"), schedule, null)).toBe("weekday_morning");
    expect(missedCycle(summer("2026-10-07T07:30"), schedule, summer("2026-10-06T17:02"))).toBe("weekday_morning");
  });

  it("returns null once a cycle started at or after the slot", () => {
    expect(missedCycle(summer("2026-10-07T08:00"), schedule, summer("2026-10-07T07:00"))).toBeNull();
    expect(missedCycle(summer("2026-10-07T08:00"), schedule, summer("2026-10-07T07:00:05"))).toBeNull();
    // a manual cycle at 07:40 also satisfies the 07:00 slot
    expect(missedCycle(summer("2026-10-07T12:00"), schedule, summer("2026-10-07T07:40"))).toBeNull();
  });

  it("returns the evening cycle after 17:00 when only the morning ran", () => {
    expect(missedCycle(summer("2026-10-07T18:00"), schedule, summer("2026-10-07T07:05"))).toBe("weekday_evening");
    expect(missedCycle(summer("2026-10-07T18:00"), schedule, summer("2026-10-07T17:00:30"))).toBeNull();
  });

  it("is due at exactly the slot time, and not a second before", () => {
    expect(missedCycle(summer("2026-10-07T07:00"), schedule, summer("2026-10-06T17:05"))).toBe("weekday_morning");
    expect(missedCycle(new Date(summer("2026-10-07T07:00").getTime() - 1000), schedule, summer("2026-10-06T17:05"))).toBeNull();
  });

  it("returns null when there is no slot yet since the last cycle", () => {
    expect(missedCycle(summer("2026-10-07T06:59"), schedule, summer("2026-10-06T17:01"))).toBeNull();
    expect(missedCycle(summer("2026-10-07T12:00"), schedule, summer("2026-10-07T07:01"))).toBeNull();
  });

  it("on a fresh install (no cycle ever) catches up the latest slot", () => {
    expect(missedCycle(summer("2026-10-07T12:00"), schedule, null)).toBe("weekday_morning");
  });

  it("only reports the most recent missed cycle, however long the runner was down", () => {
    expect(missedCycle(summer("2026-10-07T18:00"), schedule, summer("2026-10-01T07:05"))).toBe("weekday_evening");
  });
});

describe("missedCycle: weekend", () => {
  // 2026-10-10 Saturday, 2026-10-11 Sunday, 2026-10-12 Monday
  it("fires the weekend cycle on Saturday after 09:00", () => {
    expect(missedCycle(summer("2026-10-10T10:00"), schedule, summer("2026-10-09T17:05"))).toBe("weekend");
  });

  it("does not fire before 09:00 on Saturday when the Friday evening cycle ran", () => {
    expect(missedCycle(summer("2026-10-10T08:00"), schedule, summer("2026-10-09T17:05"))).toBeNull();
    expect(missedCycle(summer("2026-10-10T08:00"), schedule, summer("2026-10-09T07:05"))).toBe("weekday_evening");
  });

  it("Monday before 07:00 still owes the Sunday cycle", () => {
    expect(missedCycle(summer("2026-10-12T06:00"), schedule, summer("2026-10-10T09:05"))).toBe("weekend");
    expect(missedCycle(summer("2026-10-12T06:00"), schedule, summer("2026-10-11T09:05"))).toBeNull();
  });

  it("Friday evening is followed by no cycle until Saturday 09:00", () => {
    expect(missedCycle(summer("2026-10-10T08:59"), schedule, summer("2026-10-09T17:00"))).toBeNull();
  });
});

describe("missedCycle: midnight and configuration", () => {
  it("looks across midnight", () => {
    expect(missedCycle(summer("2026-10-08T00:10"), schedule, summer("2026-10-07T17:20"))).toBeNull();
    expect(missedCycle(summer("2026-10-08T00:10"), schedule, summer("2026-10-07T07:10"))).toBe("weekday_evening");
    // a manual run just before midnight counts
    expect(missedCycle(summer("2026-10-08T00:10"), schedule, summer("2026-10-07T23:59"))).toBeNull();
  });

  it("interprets cron times in the schedule's time zone, not UTC", () => {
    // 05:30 UTC is 07:30 Berlin (summer): the 07:00 slot is due.
    expect(missedCycle(new Date("2026-10-07T05:30:00Z"), schedule, summer("2026-10-06T17:05"))).toBe("weekday_morning");
    // 04:30 UTC is 06:30 Berlin: not yet.
    expect(missedCycle(new Date("2026-10-07T04:30:00Z"), schedule, summer("2026-10-06T17:05"))).toBeNull();
    // winter offset: 06:30 UTC is 07:30 Berlin (CET)
    expect(missedCycle(new Date("2026-12-02T06:30:00Z"), schedule, winter("2026-12-01T17:05"))).toBe("weekday_morning");
    expect(missedCycle(new Date("2026-12-02T05:30:00Z"), schedule, winter("2026-12-01T17:05"))).toBeNull();
  });

  it("ignores disabled cycles", () => {
    const noEvening = withCycles({ weekday_evening: { enabled: false } });
    expect(missedCycle(summer("2026-10-07T18:00"), noEvening, summer("2026-10-07T07:05"))).toBeNull();
    const none = withCycles({
      weekday_morning: { enabled: false },
      weekday_evening: { enabled: false },
      weekend: { enabled: false },
    });
    expect(missedCycle(summer("2026-10-07T18:00"), none, null)).toBeNull();
  });

  it("reports the slot that was missed", () => {
    const missed = findMissedCycle(summer("2026-10-07T18:00"), schedule, summer("2026-10-07T07:05"));
    expect(missed?.kind).toBe("weekday_evening");
    expect(missed?.slot).toEqual(summer("2026-10-07T17:00"));
  });
});

describe("missedCycle: DST change days in Europe/Berlin", () => {
  it("spring forward (2026-03-29, Sunday): the 09:00 weekend slot is 07:00 UTC", () => {
    const lastSaturday = winter("2026-03-28T09:05");
    // 08:30 CEST (06:30 UTC): the slot is 07:00 UTC; a fixed +01:00 offset would put it at 08:00 UTC
    expect(missedCycle(new Date("2026-03-29T06:30:00Z"), schedule, lastSaturday)).toBeNull();
    // 09:30 CEST: due
    expect(missedCycle(new Date("2026-03-29T07:30:00Z"), schedule, lastSaturday)).toBe("weekend");
    expect(latestSlotAtOrBefore("0 9 * * 0,6", TZ, new Date("2026-03-29T07:30:00Z"))).toEqual(new Date("2026-03-29T07:00:00Z"));
  });

  it("fall back (2026-10-25, Sunday): the 09:00 weekend slot is 08:00 UTC", () => {
    const lastSaturday = summer("2026-10-24T09:05");
    // 08:30 CET (07:30 UTC): not due; a fixed +02:00 offset would have fired at 07:00 UTC
    expect(missedCycle(new Date("2026-10-25T07:30:00Z"), schedule, lastSaturday)).toBeNull();
    expect(missedCycle(new Date("2026-10-25T08:30:00Z"), schedule, lastSaturday)).toBe("weekend");
  });

  it("the Monday after the spring change still uses CEST for 07:00", () => {
    expect(latestSlotAtOrBefore("0 7 * * 1-5", TZ, new Date("2026-03-30T05:30:00Z"))).toEqual(new Date("2026-03-30T05:00:00Z"));
  });

  it("pins croner's behaviour for a time that does not exist (02:30 on 2026-03-29): it fires at 03:30 CEST", () => {
    const slot = latestSlotAtOrBefore("30 2 * * *", TZ, new Date("2026-03-29T03:00:00Z"));
    expect(slot).toEqual(new Date("2026-03-29T01:30:00Z"));
    expect(latestSlotAtOrBefore("30 2 * * *", TZ, new Date("2026-03-29T01:00:00Z"))).toEqual(new Date("2026-03-28T01:30:00Z"));
  });

  it("pins croner's behaviour for a time that happens twice (02:30 on 2026-10-25): it fires once, at the first 02:30", () => {
    expect(latestSlotAtOrBefore("30 2 * * *", TZ, new Date("2026-10-25T05:00:00Z"))).toEqual(new Date("2026-10-25T00:30:00Z"));
    // between the two 02:30s nothing new is due
    expect(latestSlotAtOrBefore("30 2 * * *", TZ, new Date("2026-10-25T01:45:00Z"))).toEqual(new Date("2026-10-25T00:30:00Z"));
  });
});

describe("formatSlot", () => {
  it("shows the wall clock in the schedule's zone and the UTC instant", () => {
    expect(formatSlot(new Date("2026-10-08T05:00:00Z"), TZ)).toBe("2026-10-08 07:00 Europe/Berlin (2026-10-08T05:00:00.000Z)");
  });
});

describe("createScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const logger = createLogger({ sink: () => {} });

  it("schedules one job per enabled cycle with its next run in the schedule's time zone", () => {
    vi.useFakeTimers({ now: summer("2026-10-07T06:00") });
    const scheduler = createScheduler({ schedule: withCycles({ weekend: { enabled: false } }), onTrigger: () => {}, logger });
    const jobs = scheduler.describe();
    expect(jobs.map((j) => j.kind)).toEqual(["weekday_morning", "weekday_evening"]);
    expect(jobs[0]?.nextRun).toEqual(summer("2026-10-07T07:00"));
    expect(jobs[1]?.nextRun).toEqual(summer("2026-10-07T17:00"));
    scheduler.stop();
  });

  it("fires the trigger with the cycle kind at its slot", async () => {
    vi.useFakeTimers({ now: summer("2026-10-07T06:55") });
    const fired: string[] = [];
    const scheduler = createScheduler({ schedule, onTrigger: (kind) => void fired.push(kind), logger });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(fired).toEqual(["weekday_morning"]);
    scheduler.stop();
  });

  it("re-schedules on hot reload and stops cleanly", async () => {
    vi.useFakeTimers({ now: summer("2026-10-07T06:55") });
    const fired: string[] = [];
    // One enabled cycle keeps the fake-timer work small: croner re-arms a timer every few seconds per job,
    // and the cost of advancing a long span grows with the number of jobs (a loaded machine hit the 5 s limit).
    const only = (cron: string): ScheduleConfig =>
      withCycles({ weekday_morning: { cron }, weekday_evening: { enabled: false }, weekend: { enabled: false } });
    const scheduler = createScheduler({ schedule: only("0 7 * * 1-5"), onTrigger: (kind) => void fired.push(kind), logger });
    scheduler.reschedule(only("30 8 * * 1-5"));
    expect(scheduler.describe()).toMatchObject([{ kind: "weekday_morning", cron: "30 8 * * 1-5", nextRun: summer("2026-10-07T08:30") }]);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // past the old 07:00 slot: it was replaced, so nothing fires
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(95 * 60 * 1000); // past the new 08:30 slot
    expect(fired).toEqual(["weekday_morning"]);
    scheduler.stop();
    expect(scheduler.describe()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // nothing left armed
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(fired).toEqual(["weekday_morning"]);
  });

  it("logs a failing trigger instead of throwing", async () => {
    vi.useFakeTimers({ now: summer("2026-10-07T06:59") });
    const lines: string[] = [];
    const capture = createLogger({ sink: (r) => lines.push(`${r.level}:${r.message}`) });
    const scheduler = createScheduler({
      schedule,
      onTrigger: () => {
        throw new Error("boom");
      },
      logger: capture,
    });
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(lines).toContain("error:scheduled cycle failed");
    scheduler.stop();
  });
});
