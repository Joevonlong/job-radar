/**
 * What `scripts/ops/deploy.sh` waits for before it recreates the containers. A running cycle cannot be resumed (the
 * runner's catch-up runs a cut-off scheduled slot again, but that collects everything once more), so the deploy waits for it,
 * bounded by `schedule.yaml: deploy.drain_timeout_seconds`. Control requests are not waited for: one a restart interrupts goes
 * back to the queue (`requeueInterruptedControlRequests`), only reported so nothing happens silently.
 */
export interface DrainProbe {
  /** Cycles with status `running`. */
  runningCycles(): Promise<number>;
  /** AI control requests (the ai-worker's) with status `running`. */
  runningAiRequests(): Promise<number>;
}

export interface DrainOptions {
  probe: DrainProbe;
  timeoutMs: number;
  pollMs: number;
  log: (message: string) => void;
  /** Applied to every probe call: a query that hangs must not hang the deploy (it rejects, the caller maps that to "could not check"). */
  guard?: <T>(work: Promise<T>, label: string) => Promise<T>;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type DrainResult = { status: "idle"; waitedMs: number } | { status: "timeout"; waitedMs: number; runningCycles: number };

/** Wait until no cycle runs, at most `timeoutMs` (0 = only look once). Reports running AI requests once, at the start. */
export async function waitForRunningCycles(options: DrainOptions): Promise<DrainResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const guard = options.guard ?? (<T>(work: Promise<T>) => work);
  const started = now();
  const ai = await guard(options.probe.runningAiRequests(), "AI request check");
  if (ai > 0) options.log(`${ai} AI request(s) running: not waited for, a restart of the ai-worker puts them back in the queue and they run again`);
  let cycles = await guard(options.probe.runningCycles(), "cycle check");
  if (cycles === 0) {
    options.log("no cycle running");
    return { status: "idle", waitedMs: 0 };
  }
  options.log(`${cycles} cycle(s) running: waiting up to ${Math.round(options.timeoutMs / 1000)}s for it to finish`);
  while (cycles > 0) {
    const waited = now() - started;
    if (waited >= options.timeoutMs) return { status: "timeout", waitedMs: waited, runningCycles: cycles };
    await sleep(Math.max(1, Math.min(options.pollMs, options.timeoutMs - waited)));
    cycles = await guard(options.probe.runningCycles(), "cycle check");
  }
  const waitedMs = now() - started;
  options.log(`the cycle finished after ${Math.round(waitedMs / 1000)}s`);
  return { status: "idle", waitedMs };
}

/** Exit codes of `pnpm ops:drain`. */
export const DRAIN_EXIT = { idle: 0, cycleStillRunning: 1, badArguments: 2, couldNotCheck: 3 } as const;

/** An unexpected error after the first probe (config, database, a hung query) means "could not check", not "a cycle is running". */
export function drainExitCode(outcome: DrainResult | { error: unknown }): number {
  if ("error" in outcome) return DRAIN_EXIT.couldNotCheck;
  return outcome.status === "timeout" ? DRAIN_EXIT.cycleStillRunning : DRAIN_EXIT.idle;
}
