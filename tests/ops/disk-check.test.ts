// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDiskChecker } from "@/lib/ops/disk-check";

const MIN = 60_000;

function setup(run: () => Promise<boolean>) {
  const logs: string[] = [];
  const checker = createDiskChecker({ run: vi.fn(run), intervalMs: () => 10 * MIN, timeoutMs: () => 20_000, log: (m) => logs.push(m) });
  return { logs, checker };
}

describe("createDiskChecker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a blocked measurement: exactly one attempt in flight, no further attempt while it is unsettled, one skip message", async () => {
    const run = vi.fn(() => new Promise<boolean>(() => {})); // an fs call that never returns
    const logs: string[] = [];
    const checker = createDiskChecker({ run, intervalMs: () => 10 * MIN, timeoutMs: () => 20_000, log: (m) => logs.push(m) });
    checker.tick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logs).toEqual(["disk measurement failed: disk measurement did not finish within 20s"]);
    for (let i = 0; i < 100; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000); // every heartbeat, well past the interval
      checker.tick();
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(checker.blocked).toBe(true);
    expect(logs.filter((l) => l.startsWith("skipping disk checks"))).toEqual(["skipping disk checks: a previous measurement is still blocked"]);
  });

  it("a late settle frees the slot; the next attempt waits for the interval", async () => {
    let release: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const checker = createDiskChecker({ run, intervalMs: () => 10 * MIN, timeoutMs: () => 20_000, log: () => {} });
    checker.tick();
    await vi.advanceTimersByTimeAsync(25_000);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(checker.blocked).toBe(false);
    checker.tick();
    expect(run).toHaveBeenCalledTimes(1); // still inside the back-off
    await vi.advanceTimersByTimeAsync(10 * MIN);
    checker.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a failure (rejection) backs off to the normal interval instead of retrying on the next heartbeat", async () => {
    const { checker, logs } = setup(async () => { throw new Error("EIO"); });
    checker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toEqual(["disk measurement failed: EIO"]);
    await vi.advanceTimersByTimeAsync(30_000);
    checker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    checker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveLength(2);
  });

  it("a success also waits the interval", async () => {
    const { checker } = setup(async () => true);
    checker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(checker.blocked).toBe(false);
    checker.tick();
    expect(checker.blocked).toBe(false); // nothing started again
  });
});
