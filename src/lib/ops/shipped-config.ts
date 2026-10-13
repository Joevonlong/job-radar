/**
 * Each long-running process reports the identity of the shipped defaults directory it runs with (`shipped_config:<process>`
 * in `runtime_state`), so `pnpm run doctor` can tell which config the running web, runner and ai-worker have.
 *
 *   - web: once at start-up (`instrumentation.ts`); until one write succeeds, again on each `/api/health` request;
 *   - runner, ai-worker: with every heartbeat, under the heartbeat's time limit.
 *
 * A failed report is only a warning in the log: it never stops a process or fails a heartbeat.
 */
import os from "node:os";

import { loadConfig } from "@/lib/config";
import { getDefaultsDir } from "@/lib/config/paths";
import { ShippedConfigError, shippedConfigId, shortShippedConfigId, type ShippedConfigProcess } from "@/lib/config/shipped-id";
import { getDb, type Db } from "@/lib/db/client";
import { reportShippedConfig } from "@/lib/db/repos/runtime-state";

import { TimeoutError, withTimeout } from "./timeout";

export interface ShippedConfigReporterOptions {
  process: ShippedConfigProcess;
  db: () => Db;
  log: (message: string) => void;
  /** The shipped defaults directory (default `getDefaultsDir()`), read again on every report. */
  dir?: () => string;
  /** Give up on one report after this long (the heartbeat's time limit); unset: no limit. */
  timeoutMs?: () => number;
  /** Defaults: this process, the host name (in a container: the start of the container id), the process start. */
  pid?: number;
  instance?: string;
  startedAt?: Date;
}

export interface ShippedConfigReporter {
  /** Compute the identity and write the report; true when it was written. Never throws. */
  report(): Promise<boolean>;
}

/** Why a report failed, without connection details (C4): our own errors and time-outs by message, others by class. */
function describeFailure(error: unknown): string {
  if (error instanceof ShippedConfigError || error instanceof TimeoutError) return error.message;
  return error instanceof Error ? error.name : "unknown error";
}

export function createShippedConfigReporter(options: ShippedConfigReporterOptions): ShippedConfigReporter {
  const pid = options.pid ?? process.pid;
  const instance = options.instance ?? os.hostname();
  const startedAt = (options.startedAt ?? new Date(Date.now() - process.uptime() * 1000)).toISOString();
  const dirOf = options.dir ?? getDefaultsDir;
  let written = false;
  let lastProblem: string | null = null;

  const write = async (): Promise<{ id: string; dir: string }> => {
    const dir = dirOf();
    const id = await shippedConfigId(dir);
    await reportShippedConfig(options.db(), options.process, { id, dir, instance, pid, startedAt });
    return { id, dir };
  };

  return {
    async report() {
      try {
        // The limit first: when reading it fails, no write is left running unobserved.
        const limitMs = options.timeoutMs?.();
        const work = write();
        const { id, dir } = limitMs === undefined ? await work : await withTimeout(work, limitMs, "shipped config report");
        if (!written || lastProblem !== null) options.log(`shipped config ${dir} (${shortShippedConfigId(id)}) reported`);
        written = true;
        lastProblem = null;
        return true;
      } catch (error) {
        const problem = describeFailure(error);
        // Said once per kind of problem, not on every heartbeat.
        if (problem !== lastProblem) options.log(`WARNING: could not report the shipped config: ${problem}`);
        lastProblem = problem;
        return false;
      }
    },
  };
}

/**
 * Retry until one report succeeds: concurrent calls share the attempt in flight, and after a success every call resolves
 * at once without writing again (the web's report: start-up, then each health check until it worked). Give the reporter a
 * time limit: an attempt that never settles would otherwise be shared by every later call, and nothing would retry.
 */
export function createReportOnce(reporter: ShippedConfigReporter): () => Promise<boolean> {
  let done = false;
  let pending: Promise<boolean> | null = null;
  return () => {
    if (done) return Promise.resolve(true);
    if (pending !== null) return pending;
    pending = reporter.report().then((ok) => {
      done = ok;
      pending = null;
      return ok;
    });
    return pending;
  };
}

const WEB_REPORT = Symbol.for("job-radar.shipped-config.web");
type WebGlobal = typeof globalThis & { [WEB_REPORT]?: () => Promise<boolean> };

/**
 * The web's report. One per server process: Next.js may load `instrumentation.ts` and the route handlers as separate module
 * copies, so the state lives on `globalThis`. Each attempt is limited to `schedule.yaml doctor.probe_timeout_seconds` (what
 * the doctor waits for one answer), so a write stuck on a dead connection or a lock is abandoned and the next health check
 * tries again.
 */
export function reportWebShippedConfig(): Promise<boolean> {
  const holder = globalThis as WebGlobal;
  holder[WEB_REPORT] ??= createReportOnce(
    createShippedConfigReporter({
      process: "web",
      db: getDb,
      log: (message) => console.log(`[config] ${message}`),
      timeoutMs: () => loadConfig("schedule").doctor.probe_timeout_seconds * 1000,
    }),
  );
  return holder[WEB_REPORT]();
}
