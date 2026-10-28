import { createHeartbeatWatchdog } from "@/lib/ops/heartbeat-watchdog";
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
  exit: (code: number) => void;
}

/** Run the runner's liveness checks separately from collection and control requests. */
export async function runRunnerHeartbeats(options: HeartbeatLoopOptions): Promise<void> {
  const watchdog = createHeartbeatWatchdog({ maxFailureSeconds: options.maxFailureSeconds });
  while (!options.signal.aborted) {
    try {
      await withTimeout(options.writeHeartbeat(), options.intervalMs, "heartbeat write");
      watchdog.succeeded();
      try {
        await withTimeout(options.pruneHeartbeats(), options.intervalMs, "heartbeat prune");
      } catch (error) {
        options.log(`heartbeat prune failed: ${error instanceof Error ? error.name : "unknown error"}`);
      }
    } catch (error) {
      options.log(`heartbeat failed: ${error instanceof Error ? error.name : "unknown error"}`);
      if (watchdog.failed()) {
        options.log(`no heartbeat could be written for ${options.maxFailureSeconds}s; exiting so that Docker restarts the runner`);
        options.exit(1);
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
