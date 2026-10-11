/**
 * Bounded shutdown for the long-running processes (ai-worker, runner).
 *
 * A SIGTERM only aborts a controller; the process ends when `main()` has awaited its poller, heartbeat loop and pool. If any
 * of those never settles (a query on a dead socket after the database container was recreated, a child process that ignores
 * its abort), the process would sit there for good: launchd / Docker believe it is still alive and never restart it, and a
 * second SIGTERM used to be ignored. This module makes the end certain:
 *
 *   - 1st SIGTERM / SIGINT: log it, abort, and start a grace timer (`graceMs`, from ai.yaml `host_worker.shutdown_grace_seconds`);
 *   - when the timer fires first: log an error and force `exit(1)` so the supervisor restarts the process;
 *   - 2nd signal: log and force `exit(1)` at once;
 *   - an uncaught exception / unhandled rejection is an error: log it with the reason and shut down the same way.
 */
import { abandonedWorkCount } from "./timeout";

export interface ShutdownOptions {
  /** Log line sink (prefixed and timestamped by the caller). */
  log: (message: string) => void;
  /** Aborted when shutdown starts. */
  abort: AbortController;
  /** Grace period in ms, read when shutdown starts (config may have been hot-reloaded). */
  graceMs: () => number;
  /** Ends the process; `process.exit` in production. */
  exit: (code: number) => void;
  /** The emitter signals arrive on (`process`); injectable for tests. */
  target?: Pick<NodeJS.Process, "on" | "off">;
}

export interface Shutdown {
  /** Start the shutdown for a reason that is not a signal (an error); the first call wins. */
  begin(reason: string, exitCode?: number): void;
  /** Mark the normal end: cancels the grace timer. Call right before returning from `main`. */
  done(): void;
  /** 0 after a signal, 1 when the shutdown began with an error. */
  exitCode(): number;
  /** Remove the listeners (tests). */
  dispose(): void;
}

export function installShutdown(options: ShutdownOptions): Shutdown {
  const { log, abort, exit } = options;
  const target = options.target ?? process;
  let timer: NodeJS.Timeout | undefined;
  let forcedCode = 0;

  const force = (message: string): void => {
    log(`ERROR ${message}`);
    exit(forcedCode === 0 ? 1 : forcedCode);
  };

  const begin = (reason: string, exitCode = 0): void => {
    if (abort.signal.aborted) {
      if (reason.startsWith("received ")) force(`${reason} again while shutting down: forcing exit`);
      return;
    }
    forcedCode = exitCode;
    log(exitCode === 0 ? `${reason}, shutting down` : `ERROR ${reason}, shutting down`);
    const graceMs = Math.max(1, options.graceMs());
    timer = setTimeout(() => force(`shutdown did not finish within ${Math.round(graceMs / 1000)}s: forcing exit`), graceMs);
    abort.abort();
  };

  const onTerm = (): void => begin("received SIGTERM");
  const onInt = (): void => begin("received SIGINT");
  const onRejection = (reason: unknown): void => begin(`unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`, 1);
  const onException = (error: Error): void => begin(`uncaught exception: ${error.name}: ${error.message}`, 1);
  target.on("SIGTERM", onTerm);
  target.on("SIGINT", onInt);
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);

  return {
    begin,
    exitCode: () => forcedCode,
    done() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      this.done();
      target.off("SIGTERM", onTerm);
      target.off("SIGINT", onInt);
      target.off("unhandledRejection", onRejection);
      target.off("uncaughtException", onException);
    },
  };
}

/**
 * End the process now. `process.exit` waits for the libuv thread pool, so one abandoned blocking fs call (see `withTimeout`: a
 * read stuck behind a macOS privacy prompt) makes it hang after "stopped" for good: the second half of that fix. With abandoned work
 * the process kills itself with SIGKILL instead (launchd restarts it either way; the logs are written synchronously).
 */
export function exitProcess(code: number): never {
  if (abandonedWorkCount() > 0) process.kill(process.pid, "SIGKILL");
  return process.exit(code);
}
