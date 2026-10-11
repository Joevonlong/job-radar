// @vitest-environment node
import { describe, expect, it } from "vitest";

import { countTodayScope } from "@/lib/dashboard/today-scope";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-07T05:00:00Z"); // 07:00 in Berlin
const base = { now: NOW, timezone: "Europe/Berlin" };

describe("countTodayScope", () => {
  it("counts the cycle's jobs and today's separately; a job can be in both", () => {
    const jobs = [{ firstSeenAt: at("2026-10-06T20:10:00Z") }, { firstSeenAt: at("2026-10-06T22:30:00Z") }, { firstSeenAt: at("2026-10-07T03:00:00Z") }];
    const cycle = { startedAt: at("2026-10-06T20:00:00Z"), finishedAt: at("2026-10-06T22:40:00Z") };
    expect(countTodayScope(jobs, { ...base, cycle })).toEqual({ cycle: 2, today: 2 });
  });

  it("is 0 for today (not missing) when only last night's cycle contributed", () => {
    const jobs = [{ firstSeenAt: at("2026-10-06T20:10:00Z") }];
    expect(countTodayScope(jobs, { ...base, cycle: { startedAt: at("2026-10-06T20:00:00Z"), finishedAt: at("2026-10-06T20:30:00Z") } })).toEqual({ cycle: 1, today: 0 });
  });

  it("has no cycle count before the first cycle, and treats a running cycle as open-ended", () => {
    const jobs = [{ firstSeenAt: at("2026-10-07T04:50:00Z") }];
    expect(countTodayScope(jobs, { ...base, cycle: null })).toEqual({ cycle: null, today: 1 });
    expect(countTodayScope(jobs, { ...base, cycle: { startedAt: at("2026-10-07T04:40:00Z"), finishedAt: null } })).toEqual({ cycle: 1, today: 1 });
  });

  it("uses the calendar day of the time zone", () => {
    const jobs = [{ firstSeenAt: at("2026-10-06T22:30:00Z") }]; // already Oct 7 in Berlin, still Oct 6 in UTC
    expect(countTodayScope(jobs, { ...base, cycle: null }).today).toBe(1);
    expect(countTodayScope(jobs, { now: NOW, timezone: "UTC", cycle: null }).today).toBe(0);
  });
});
