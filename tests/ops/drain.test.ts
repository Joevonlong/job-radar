import { describe, expect, it } from "vitest";

import { DRAIN_EXIT, drainExitCode, waitForRunningCycles, type DrainProbe } from "@/lib/ops/drain";

/** A probe that reports the given running-cycle counts one after the other (the last repeats), and a fake clock. */
function setup(cycleCounts: number[], aiRunning = 0) {
  let clock = 0;
  let calls = 0;
  const lines: string[] = [];
  const probe: DrainProbe = {
    runningCycles: async () => cycleCounts[Math.min(calls++, cycleCounts.length - 1)] ?? 0,
    runningAiRequests: async () => aiRunning,
  };
  const sleeps: number[] = [];
  return {
    lines,
    sleeps,
    options: {
      probe,
      log: (line: string) => lines.push(line),
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe("waitForRunningCycles", () => {
  it("returns at once when no cycle runs, and reports AI requests in flight without waiting for them", async () => {
    const t = setup([0], 2);
    expect(await waitForRunningCycles({ ...t.options, timeoutMs: 60_000, pollMs: 5_000 })).toEqual({ status: "idle", waitedMs: 0 });
    expect(t.sleeps).toEqual([]);
    expect(t.lines.join("\n")).toContain("2 AI request(s) running");
  });

  it("waits until the running cycle has finished", async () => {
    const t = setup([1, 1, 1, 0]);
    expect(await waitForRunningCycles({ ...t.options, timeoutMs: 60_000, pollMs: 5_000 })).toEqual({ status: "idle", waitedMs: 15_000 });
    expect(t.sleeps).toEqual([5_000, 5_000, 5_000]);
  });

  it("gives up after the timeout, never sleeping past it", async () => {
    const t = setup([1]);
    expect(await waitForRunningCycles({ ...t.options, timeoutMs: 12_000, pollMs: 5_000 })).toEqual({ status: "timeout", waitedMs: 12_000, runningCycles: 1 });
    expect(t.sleeps).toEqual([5_000, 5_000, 2_000]);
  });

  it("timeout 0 only looks once", async () => {
    const t = setup([1]);
    expect(await waitForRunningCycles({ ...t.options, timeoutMs: 0, pollMs: 5_000 })).toMatchObject({ status: "timeout", waitedMs: 0 });
    expect(t.sleeps).toEqual([]);
  });
});

describe("drain guard and exit codes", () => {
  it("every probe call goes through the guard, so a hanging query can be cut off", async () => {
    const t = setup([1, 0]);
    const labels: string[] = [];
    await waitForRunningCycles({ ...t.options, timeoutMs: 60_000, pollMs: 5_000, guard: (work, label) => (labels.push(label), work) });
    expect(labels).toEqual(["AI request check", "cycle check", "cycle check"]);
  });

  it("a guard that rejects (a hung poll query) propagates instead of reporting a cycle", async () => {
    const t = setup([1, 1]);
    let calls = 0;
    const guard = <T,>(work: Promise<T>): Promise<T> => (++calls >= 3 ? Promise.reject(new Error("cycle check did not finish within 10s")) : work);
    await expect(waitForRunningCycles({ ...t.options, timeoutMs: 60_000, pollMs: 5_000, guard })).rejects.toThrow("did not finish");
  });

  it("maps outcomes to exit codes: 0 idle, 1 still running, 3 could not check", () => {
    expect(drainExitCode({ status: "idle", waitedMs: 0 })).toBe(DRAIN_EXIT.idle);
    expect(drainExitCode({ status: "timeout", waitedMs: 5, runningCycles: 1 })).toBe(1);
    expect(drainExitCode({ error: new Error("boom") })).toBe(3);
    expect(DRAIN_EXIT.badArguments).toBe(2);
  });
});
