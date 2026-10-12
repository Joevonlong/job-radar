// @vitest-environment node
import { describe, expect, it } from "vitest";

import { lastCycleCheck, nextCycleCheck } from "@/lib/ops/doctor/checks/schedule";
import type { LatestCycleRuns } from "@/lib/db/queries/sources";

import { makeContext, NOW, only, sourcesView } from "./helpers";

const cycle = (extra: Partial<LatestCycleRuns>): LatestCycleRuns => ({
  id: 7,
  kind: "weekday_morning",
  status: "succeeded",
  startedAt: new Date("2026-10-07T05:00:30Z"),
  finishedAt: new Date("2026-10-07T05:08:00Z"),
  channels: [],
  ...extra,
});
const withCycle = (latestCycle: LatestCycleRuns | null, overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, probes: { sources: async () => sourcesView({ latestCycle }), ...overrides.probes } });

describe("cycle.last", () => {
  it("ok when the last cycle succeeded and nothing was missed", async () => {
    const r = await only(lastCycleCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("weekday_morning");
    expect(r.detail).toContain("2026-10-07 07:00");
    expect(r.detail).toContain("成功");
  });
  it("fails when the last cycle failed", async () => {
    const r = await only(lastCycleCheck, withCycle(cycle({ status: "failed" })));
    expect(r.status).toBe("fail");
    expect(r.hint).toContain("logs");
  });
  it("warns on a partial cycle and names the failed channels", async () => {
    const channels = [{ channelId: "indeed", family: "indeed", runs: 3, succeeded: 0, failed: 3, skipped: 0, interrupted: 0, fetched: 0 }];
    const r = await only(lastCycleCheck, withCycle(cycle({ status: "partial", channels })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("indeed");
  });
  it("names a channel whose queries were all interrupted, but not one whose runs only had invalid records", async () => {
    // both shapes are `partial` runs with error code parse; getLatestCycleRuns counts the first as interrupted, the second as succeeded
    const channels = [
      { channelId: "stepstone", family: "stepstone", runs: 2, succeeded: 0, failed: 0, skipped: 0, interrupted: 2, fetched: 40 },
      { channelId: "xing", family: "xing", runs: 2, succeeded: 2, failed: 0, skipped: 0, interrupted: 0, fetched: 40 },
    ];
    const r = await only(lastCycleCheck, withCycle(cycle({ status: "partial", channels })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("stepstone");
    expect(r.detail).not.toContain("xing");
  });
  it("warns when no cycle has run yet", async () => {
    const r = await only(lastCycleCheck, withCycle(null));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("还没有跑过");
  });
  it("fails when a scheduled slot passed its grace period without a cycle", async () => {
    // the 07:00 Berlin slot (05:00Z) is long past; the last cycle is from the day before
    const r = await only(lastCycleCheck, withCycle(cycle({ startedAt: new Date("2026-10-06T15:00:30Z"), kind: "weekday_evening" })));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("错过了 2026-10-07 07:00");
    expect(r.hint).toContain("catch_up");
  });
  it("does not call a slot missed within doctor.cycle_grace_minutes", async () => {
    const ctx = withCycle(cycle({ startedAt: new Date("2026-10-06T15:00:30Z"), kind: "weekday_evening" }), { now: new Date("2026-10-07T05:30:00Z") });
    expect((await only(lastCycleCheck, ctx)).status).toBe("ok");
    const late = withCycle(cycle({ startedAt: new Date("2026-10-06T15:00:30Z"), kind: "weekday_evening" }), { now: new Date("2026-10-07T06:31:00Z") });
    expect((await only(lastCycleCheck, late)).status).toBe("fail");
  });
  it("a running cycle is fine", async () => {
    expect((await only(lastCycleCheck, withCycle(cycle({ status: "running", finishedAt: null })))).detail).toContain("还在运行");
  });
});

describe("cycle.next", () => {
  it("names the next slot in the schedule's time zone", async () => {
    const r = await only(nextCycleCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("weekday_evening");
    expect(r.detail).toContain("2026-10-07 17:00 Europe/Berlin");
    expect(r.detail).toContain("3 小时后");
  });
  it("skips disabled cycles", async () => {
    const ctx = makeContext({ schedule: (raw) => ((raw.cycles as Record<string, { enabled: boolean }>).weekday_evening.enabled = false) });
    expect((await only(nextCycleCheck, ctx)).detail).toContain("weekday_morning：2026-10-08 07:00");
  });
  it("fails when every cycle is off", async () => {
    const ctx = makeContext({ schedule: (raw) => Object.values(raw.cycles as Record<string, { enabled: boolean }>).forEach((c) => (c.enabled = false)) });
    const r = await only(nextCycleCheck, ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("都关了");
  });
  it("needs no database", async () => {
    const ctx = makeContext({ probes: { dbPing: async () => false } });
    expect((await only(nextCycleCheck, ctx)).status).toBe("ok");
    expect(ctx.now).toEqual(NOW);
  });
});
