import { createHeartbeatWatchdog } from "@/lib/ops/heartbeat-watchdog";
import type { Shutdown } from "@/lib/ops/shutdown";
import { withTimeout } from "@/lib/ops/timeout";

interface HeartbeatLoopOptions {
  signal: AbortSignal;
  intervalMs: number;
  maxFailureSeconds: number;
  writeHeartbeat: () => Promise<unknown>;
  pruneHeartbeats: () => Promise<void>;
  reportConfig: () => Promise<unknown>;
  watchAiWorker: () => Promise<void>;
  sleep: () => Promise<void>;
  log: (message: string) => void;
  shutdown: Pick<Shutdown, "begin">;
}

/** Run the runner's liveness checks separately from collection and control requests. */
export async function runRunnerHeartbeats(options: HeartbeatLoopOptions): Promise<void> {
  const watchdog = createHeartbeatWatchdog({ maxFailureSeconds: options.maxFailureSeconds });
  while (!options.signal.aborted) {
    try {
      // A timeout stops waiting, but the write can still land and restore liveness later.
      const written = options.writeHeartbeat().then(() => watchdog.succeeded());
      await withTimeout(written, options.intervalMs, "heartbeat write");
      try {
        await withTimeout(options.pruneHeartbeats(), options.intervalMs, "heartbeat prune");
      } catch (error) {
        options.log(`heartbeat prune failed: ${error instanceof Error ? error.name : "unknown error"}`);
      }
    } catch (error) {
      options.log(`heartbeat failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (watchdog.failed()) {
        options.shutdown.begin(`no heartbeat could be written for ${options.maxFailureSeconds}s; exiting so that Docker restarts the runner`, 1);
        return;
      }
    }
    // A failed config report is only a warning and never counts as a failed heartbeat.
    await options.reportConfig();
    try {
      await withTimeout(options.watchAiWorker(), options.intervalMs, "ai-worker check");
    } catch (error) {
      options.log(`ai-worker check failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    try {
      await options.sleep();
    } catch {
      // aborted: leave the loop
    }
  }
}
