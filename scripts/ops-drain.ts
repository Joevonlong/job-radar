/**
 * pnpm ops:drain: wait (bounded) for a running cycle to finish before `scripts/ops/deploy.sh` recreates the containers,
 * and report AI requests in flight (those are queued again by the restart, not waited for). Limits from `schedule.yaml: deploy`
 * (`drain_timeout_seconds`, `drain_poll_seconds`); `--timeout <s>` overrides the first. DATABASE_URL is used when set, otherwise
 * it is built from .env like `pnpm run doctor` does. A database that cannot be reached (first deploy) means nothing to wait for.
 *
 * Exit code: 0 = nothing running (any more), 1 = a cycle still runs after the timeout, 2 = bad arguments,
 * 3 = could not check (config or database error after the first probe, or a query that hung).
 */
import { parseArgs } from "node:util";

import { loadConfig } from "../src/lib/config";
import { AI_CONTROL_REQUEST_KINDS, closeDb, countOpenControlRequests, countRunningCycles, getDb } from "../src/lib/db";
import { resolveHostDatabaseUrl } from "../src/lib/ops/doctor/database-url";
import { redact } from "../src/lib/ops/doctor/helpers";
import { DRAIN_EXIT, drainExitCode, waitForRunningCycles } from "../src/lib/ops/drain";
import { withTimeout } from "../src/lib/ops/timeout";

const log = (message: string): void => console.log(`ops:drain: ${message}`);

async function main(): Promise<number> {
  let values: { timeout?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ options: { timeout: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }));
  } catch (error) {
    console.error(`ops:drain: ${error instanceof Error ? error.message : "bad arguments"}`);
    return DRAIN_EXIT.badArguments;
  }
  if (values.help) {
    console.log("Usage: pnpm ops:drain [--timeout <seconds>]\nExit code: 0 nothing running, 1 a cycle still runs after the timeout, 2 bad arguments, 3 could not check.");
    return 0;
  }
  if (values.timeout !== undefined && !/^\d+$/.test(values.timeout)) {
    console.error(`ops:drain: --timeout needs a whole number of seconds, got '${values.timeout}'`);
    return DRAIN_EXIT.badArguments;
  }
  try {
    const schedule = loadConfig("schedule");
    const deploy = schedule.deploy;
    const timeoutSeconds = values.timeout === undefined ? deploy.drain_timeout_seconds : Number(values.timeout);
    process.env.DATABASE_URL = resolveHostDatabaseUrl(process.env);
    const db = getDb();
    const probeMs = schedule.doctor.command_timeout_seconds * 1000; // the same limit as each probe of `pnpm run doctor`
    const probe = {
      runningCycles: (): Promise<number> => countRunningCycles(db),
      runningAiRequests: async (): Promise<number> => (await countOpenControlRequests(db, AI_CONTROL_REQUEST_KINDS)).running,
    };
    try {
      await withTimeout(probe.runningCycles(), probeMs, "database check");
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      log(`database not reachable, nothing to wait for (${redact(cause instanceof Error ? cause.message : String(cause))})`);
      return DRAIN_EXIT.idle;
    }
    const result = await waitForRunningCycles({
      probe,
      timeoutMs: timeoutSeconds * 1000,
      pollMs: deploy.drain_poll_seconds * 1000,
      log,
      guard: (work, label) => withTimeout(work, probeMs, label),
    });
    if (result.status === "timeout") {
      log(`${result.runningCycles} cycle(s) still running after ${timeoutSeconds}s: the restart cuts it off and the runner's catch-up runs that slot again`);
    }
    return drainExitCode(result);
  } catch (error) {
    log(`could not check for a running cycle (${redact(error instanceof Error ? error.message : String(error))})`);
    return drainExitCode({ error });
  }
}

main().then(
  async (code) => {
    await Promise.race([closeDb(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`ops:drain: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(DRAIN_EXIT.couldNotCheck);
  },
);
