// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRunnerHeartbeats } from "@/runner/heartbeat";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runner heartbeat loop", () => {
  const intervalMs = 10;
  const maxFailureSeconds = 0.06;

  async function stalledLoop(step: "writeHeartbeat" | "pruneHeartbeats" | "watchAiWorker") {
    const abort = new AbortController();
    const stalled = Promise.withResolvers<void>();
    const exit = vi.fn();
    const write = vi.fn<() => Promise<void>>(async () => { throw new Error("database unavailable"); });
    // A successful first heartbeat reaches maintenance and the worker check.
    if (step !== "writeHeartbeat") write.mockResolvedValueOnce(undefined);
    const work = {
      writeHeartbeat: write,
      pruneHeartbeats: vi.fn(async () => {}),
      watchAiWorker: vi.fn(async () => {}),
      reportConfig: vi.fn(async () => {}),
    };
    work[step] = vi.fn(() => stalled.promise);
    const loop = runRunnerHeartbeats({
      ...work, signal: abort.signal, intervalMs, maxFailureSeconds, log: vi.fn(), exit,
      sleep: () => new Promise((resolve) => setTimeout(resolve, intervalMs)),
    });
    try {
      await vi.advanceTimersByTimeAsync(maxFailureSeconds * 1000 - intervalMs);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(intervalMs * 11);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(work.writeHeartbeat.mock.calls.length).toBeGreaterThan(1);
      expect(work.reportConfig).toHaveBeenCalled();
    } finally {
      abort.abort();
      stalled.resolve();
      await vi.runOnlyPendingTimersAsync();
      await loop;
    }
  }

  it("exits after sustained stalled writes exceed twice the healthcheck age", async () => {
    await stalledLoop("writeHeartbeat");
  });

  it.each(["pruneHeartbeats", "watchAiWorker"] as const)("a stalled %s cannot prevent further writes and the watchdog exit", stalledLoop);

  it("keeps running after a transient failure followed by successful writes", async () => {
    const abort = new AbortController();
    const exit = vi.fn();
    const writeHeartbeat = vi.fn(async () => {}).mockRejectedValueOnce(new Error("temporary failure"));
    let sleeps = 0;
    await runRunnerHeartbeats({
      signal: abort.signal, intervalMs, maxFailureSeconds, writeHeartbeat,
      pruneHeartbeats: async () => {}, reportConfig: async () => {}, watchAiWorker: async () => {},
      sleep: async () => { if (++sleeps === 10) abort.abort(); }, log: vi.fn(), exit,
    });
    expect(writeHeartbeat).toHaveBeenCalledTimes(10);
    expect(exit).not.toHaveBeenCalled();
  });
});
