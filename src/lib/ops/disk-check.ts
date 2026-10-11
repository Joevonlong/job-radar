import { withTimeout } from "./timeout";

export interface DiskCheckerOptions {
  /** One measurement: resolves true when recorded. May block forever (a stuck fs call). */
  run: () => Promise<boolean>;
  /** Normal interval between measurements (ai.yaml `host_worker.disk_check_minutes`), read at every tick. */
  intervalMs: () => number;
  /** How long one measurement is awaited (ai.yaml `host_worker.step_timeout_seconds`). */
  timeoutMs: () => number;
  log: (message: string) => void;
  now?: () => number;
}

/**
 * The ai-worker's host-disk measurement schedule. A blocking fs call cannot be cancelled and keeps its libuv
 * thread for good; four of them exhaust the pool and every fs operation of the process (config reload, log writes) hangs.
 * So: never start a measurement while an earlier one has not settled (a late settle frees the slot), and after a failure wait the
 * normal interval instead of retrying on every heartbeat.
 */
export function createDiskChecker(options: DiskCheckerOptions): { tick(): void; readonly blocked: boolean } {
  const now = options.now ?? Date.now;
  let unsettled = false; // the underlying call has not returned (even if we stopped waiting for it)
  let nextAt = Number.NEGATIVE_INFINITY;
  let announcedBlocked = false;

  return {
    get blocked() {
      return unsettled;
    },
    tick() {
      if (unsettled) {
        if (!announcedBlocked) options.log("skipping disk checks: a previous measurement is still blocked");
        announcedBlocked = true;
        return;
      }
      if (now() < nextAt) return;
      announcedBlocked = false;
      unsettled = true;
      nextAt = now() + options.intervalMs(); // success and failure alike: back off to the normal interval
      const work = options.run();
      work.then(
        () => {
          unsettled = false;
        },
        () => {
          unsettled = false;
        },
      );
      withTimeout(work, options.timeoutMs(), "disk measurement").catch((error: unknown) => options.log(`disk measurement failed: ${error instanceof Error ? error.message : "unknown error"}`));
    },
  };
}
