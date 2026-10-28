// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installShutdown } from "@/lib/ops/shutdown";
import { runRunnerHeartbeats } from "@/runner/heartbeat";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runner heartbeat loop", () => {
  const intervalMs = 10;
  const maxFailureSeconds = 0.06;

  it.each(["none", "writeHeartbeat", "pruneHeartbeats", "reportConfig"] as const)(
    "awaits a config report in every iteration with a transient failure in %s",
    async (failure) => {
      const abort = new AbortController();
      const events: string[] = [];
      const shutdown = { begin: vi.fn() };
      let iteration = 0;
      const reportConfig = vi.fn(async () => {
        // Yield so the event order also detects a report that is called without awaiting it.
        await Promise.resolve();
        events.push("report");
        // The real reporter resolves false on failure; it never throws.
        return !(failure === "reportConfig" && iteration === 1);
      });

      await runRunnerHeartbeats({
        signal: abort.signal, intervalMs, maxFailureSeconds, shutdown, log: vi.fn(),
        writeHeartbeat: async () => {
          iteration++;
          events.push("write");
          if (failure === "writeHeartbeat" && iteration === 1) throw new Error("temporary write failure");
        },
        pruneHeartbeats: async () => {
          if (failure === "pruneHeartbeats" && iteration === 1) throw new Error("temporary prune failure");
        },
        reportConfig,
        watchAiWorker: async () => { events.push("watch"); },
        sleep: async () => {
          events.push("sleep");
          if (iteration === 3) abort.abort();
        },
      });

      expect(iteration).toBe(3);
      expect(reportConfig).toHaveBeenCalledTimes(3);
      expect(events).toEqual([
        "write", "report", "watch", "sleep",
        "write", "report", "watch", "sleep",
        "write", "report", "watch", "sleep",
      ]);
      expect(shutdown.begin).not.toHaveBeenCalled();
    },
  );

  async function stalledLoop(step: "writeHeartbeat" | "pruneHeartbeats" | "watchAiWorker") {
    const abort = new AbortController();
    const stalled = Promise.withResolvers<void>();
    const shutdown = { begin: vi.fn() };
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
      ...work, signal: abort.signal, intervalMs, maxFailureSeconds, log: vi.fn(), shutdown,
      sleep: () => new Promise((resolve) => setTimeout(resolve, intervalMs)),
    });
    try {
      await vi.advanceTimersByTimeAsync(maxFailureSeconds * 1000 - intervalMs);
      expect(shutdown.begin).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(intervalMs * 11);
      expect(shutdown.begin).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no heartbeat could be written"), 1);
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
    const shutdown = { begin: vi.fn() };
    const writeHeartbeat = vi.fn(async () => {}).mockRejectedValueOnce(new Error("temporary failure"));
    let sleeps = 0;
    await runRunnerHeartbeats({
      signal: abort.signal, intervalMs, maxFailureSeconds, writeHeartbeat,
      pruneHeartbeats: async () => {}, reportConfig: async () => {}, watchAiWorker: async () => {},
      sleep: async () => { if (++sleeps === 10) abort.abort(); }, log: vi.fn(), shutdown,
    });
    expect(writeHeartbeat).toHaveBeenCalledTimes(10);
    expect(shutdown.begin).not.toHaveBeenCalled();
  });

  it("keeps running beyond the watchdog window when successful writes finish after their timeout", async () => {
    const abort = new AbortController();
    const shutdown = { begin: vi.fn() };
    const intervalMs = 1000;
    const maxFailureSeconds = 240;
    let lastHeartbeatAt = 0;
    const writeHeartbeat = vi.fn(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        lastHeartbeatAt = Date.now();
        resolve();
      }, intervalMs * 1.5);
    }));
    const loop = runRunnerHeartbeats({
      signal: abort.signal, intervalMs, maxFailureSeconds, writeHeartbeat,
      pruneHeartbeats: async () => {}, reportConfig: async () => {}, watchAiWorker: async () => {},
      sleep: () => new Promise((resolve) => setTimeout(resolve, intervalMs)), log: vi.fn(), shutdown,
    });
    try {
      await vi.advanceTimersByTimeAsync(maxFailureSeconds * 2000);
      expect(shutdown.begin).not.toHaveBeenCalled();
      expect(writeHeartbeat.mock.calls.length).toBeGreaterThan(120);
      expect(Date.now() - lastHeartbeatAt).toBeLessThan(intervalMs * 3);
    } finally {
      abort.abort();
      await vi.advanceTimersByTimeAsync(intervalMs * 3);
      await loop;
    }
  });

  it.each(["finishes", "stalls"] as const)("uses bounded shutdown when cycle cleanup %s", async (cleanup) => {
    const abort = new AbortController();
    const exit = vi.fn();
    const graceMs = intervalMs * 10;
    const target = new EventEmitter();
    const shutdown = installShutdown({ abort, graceMs: () => graceMs, log: vi.fn(), exit, target: target as unknown as NodeJS.Process });
    const events: string[] = [];
    const cycle = new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => {
        events.push("aborted");
        if (cleanup === "finishes") {
          setTimeout(() => {
            events.push("cleaned up");
            resolve();
          }, intervalMs * 2);
        }
      }, { once: true });
    });
    const loop = runRunnerHeartbeats({
      signal: abort.signal, intervalMs, maxFailureSeconds,
      writeHeartbeat: () => new Promise<never>(() => {}),
      pruneHeartbeats: async () => {}, reportConfig: async () => {}, watchAiWorker: async () => {},
      sleep: () => new Promise((resolve) => setTimeout(resolve, intervalMs)), log: vi.fn(), shutdown,
    });
    try {
      await vi.advanceTimersByTimeAsync(maxFailureSeconds * 1000 + intervalMs);
      await loop;
      expect(events).toEqual(["aborted"]);
      expect(exit).not.toHaveBeenCalled();
      expect(shutdown.exitCode()).toBe(1);
      if (cleanup === "finishes") {
        await vi.advanceTimersByTimeAsync(intervalMs * 2);
        await cycle;
        shutdown.done();
        expect(events).toEqual(["aborted", "cleaned up"]);
      }
      await vi.advanceTimersByTimeAsync(graceMs);
      if (cleanup === "stalls") expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      else expect(exit).not.toHaveBeenCalled();
    } finally {
      shutdown.dispose();
    }
  });
});
