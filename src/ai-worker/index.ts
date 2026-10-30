/**
 * The host AI worker: a plain Node process on the Mac, started by launchd
 * (`scripts/ops/install-ai-worker.sh`) or by hand (`pnpm ai-worker`). It does the AI work with the logins of the
 * local `claude` / `codex` CLIs, so the containers need no AI credential:
 *
 *   - `run_ai`        the `ai` + `notify` steps of a cycle the container runner delegated
 *   - `translate_job` the translate button on the job page
 *   - `breakdown_job` the breakdown button on the job page
 *   - `rescore_stale` the "re-score" control of /settings
 *
 * It claims only those kinds from `control_requests`, writes its own heartbeat (`runner_heartbeats.process =
 * 'ai-worker'`) and never touches the schema (the runner migrates). `--once` handles what is queued and exits.
 *
 * Only one ai-worker runs per database: it first takes a Postgres session advisory lock (`acquireInstanceLock`). A second
 * one (a `pnpm ai-worker` in a terminal next to the launchd service, `--once` included) says who holds it and exits with
 * code 3 before it touches the queue, so it can never put the first one's running requests back into the queue.
 *
 * `--log-dir <dir>` (set by the launchd plist): write stdout / stderr to `<dir>/ai-worker.{out,err}.log` (on the external
 * volume, which launchd itself cannot write to) and rotate them by size (`ai.yaml: host_worker.log_max_mb` / `log_keep`).
 * `--launchd-log <file>`: launchd's own capture file (internal disk), rotated by the same rule.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { defaultRegistry } from "@/lib/channels/registry";
import { loadConfig, watchConfig } from "@/lib/config";
import { startControlLanes, processNextControlRequest, aiWorkerRequestKinds } from "@/lib/control";
import { registerAiControlHandlers } from "@/lib/control/ai-handlers";
import { codexVersionWarning, readCodexVersion } from "@/lib/ai/providers/codex-version";
import { registerBuiltinAiSubtasks } from "@/lib/cycle/builtin-steps";
import { closeDb, getDb, writeHeartbeat } from "@/lib/db";
import { acquireInstanceLock, type InstanceLock, type LockHolder } from "@/lib/db/instance-lock";
import { loadDatabaseEnv } from "@/lib/env";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { aiWorkerLaunchdLabel } from "@/lib/ops/ai-worker-label";
import { configGuardFindings } from "@/lib/ops/config-guards";
import { requeueInterruptedControlRequests } from "@/lib/db/repos/control-requests";
import { withTimeout } from "@/lib/ops/timeout";
import { exitProcess, installShutdown } from "@/lib/ops/shutdown";
import { createShippedConfigReporter } from "@/lib/ops/shipped-config";
import { recordHostDisk } from "@/lib/ops/disk";
import { createDiskChecker } from "@/lib/ops/disk-check";
import { redirectOutputToFiles, rotateLogFile, type FileOutput } from "@/lib/ops/log-files";
import { HEARTBEAT_PROCESS } from "@/lib/db/repos/heartbeats";
import { closeStaleActivity, createActivityRecorder } from "@/lib/activity";

const log = (message: string): void => console.log(`${new Date().toISOString()} [ai-worker] ${message}`);
/** Exit code of an ai-worker that found another one running. */
const EXIT_ALREADY_RUNNING = 3;

function describeHolder(holder: LockHolder | null): string {
  if (holder === null) return "another ai-worker is running against this database";
  const since = holder.since ? ` since ${holder.since.toISOString()}` : "";
  return `another ai-worker is running against this database (${holder.application ?? "unknown process"}${since})`;
}

/**
 * Take the single-instance lock, or say who holds it. Null: the caller exits with EXIT_ALREADY_RUNNING, after
 * `host_worker.already_running_wait_seconds` unless `--once` (launchd KeepAlive would otherwise restart it in a tight loop).
 */
async function takeInstanceLock(once: boolean): Promise<InstanceLock | null> {
  const env = loadDatabaseEnv();
  const result = await acquireInstanceLock(env.DATABASE_URL, { name: "ai-worker", connectTimeoutSeconds: env.DB_CONNECT_TIMEOUT_SECONDS });
  if (result.acquired) return result.lock;
  const waitSeconds = once ? 0 : loadConfig("ai").host_worker.already_running_wait_seconds;
  let serviceHint = "";
  if (process.platform === "darwin") {
    let label = "<label>";
    try {
      label = aiWorkerLaunchdLabel(loadConfig("schedule").doctor.ai_worker_launchd_label);
    } catch {
      // The optional hint must not bypass the lock-contention wait and exit path.
    }
    serviceHint = ` (launchd: launchctl bootout gui/$(id -u)/${label})`;
  }
  log(
    `${describeHolder(result.holder)}: exiting${waitSeconds > 0 ? ` in ${waitSeconds}s` : ""}. Stop that one first${serviceHint}, or let it handle the queue`,
  );
  if (waitSeconds > 0) await sleep(waitSeconds * 1000);
  return null;
}
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");

/** The absolute path `command` resolves to on PATH (or itself when it is a path), or null. Only for the start-up log. */
function resolveCommand(command: string): string | null {
  const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Write the output to `--log-dir`; when that fails, say so and keep the plain streams (launchd's file). */
function openLogFiles(logDir: string | undefined): FileOutput | null {
  if (logDir === undefined) return null;
  try {
    return redirectOutputToFiles(path.resolve(logDir));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : describe(error);
    console.error(`${new Date().toISOString()} [ai-worker] cannot write the log files in ${logDir} (${code}): logging to the standard streams instead`);
    return null;
  }
}

/** Rotate the log files that are too large (sizes from ai.yaml, re-read each time); never throws. */
function rotateLogs(output: FileOutput | null, launchdLog: string | undefined): void {
  if (output === null && launchdLog === undefined) return;
  try {
    const { log_max_mb: maxMb, log_keep: keep } = loadConfig("ai").host_worker;
    const maxBytes = maxMb * 1024 * 1024;
    const rotated = output?.rotate(maxBytes, keep) ?? [];
    // launchd's file is on the nearly full internal disk: its rotated copies go next to the worker's logs on the external volume.
    if (launchdLog !== undefined && rotateLogFile(launchdLog, maxBytes, keep, output?.dir)) rotated.push(launchdLog);
    for (const file of rotated) log(`rotated ${file} (over ${maxMb} MB, keeping ${keep})`);
  } catch (error) {
    log(`log rotation failed: ${describe(error)}`);
  }
}

async function main(): Promise<number> {
  let values: { once?: boolean; help?: boolean; "log-dir"?: string; "launchd-log"?: string };
  try {
    ({ values } = parseArgs({
      options: { once: { type: "boolean" }, help: { type: "boolean", short: "h" }, "log-dir": { type: "string" }, "launchd-log": { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    console.error(`ai-worker: ${describe(error)}`);
    return 2;
  }
  if (values.help) {
    console.log(
      [
        "Usage: pnpm ai-worker [--once] [--log-dir <dir>] [--launchd-log <file>]",
        "  --once                handle the queued AI requests and exit (default: keep running as the launchd service)",
        "  --log-dir <dir>       write stdout / stderr to <dir>/ai-worker.{out,err}.log and rotate them (ai.yaml host_worker.log_max_mb / log_keep)",
        "  --launchd-log <file>  launchd's own capture file: rotated by the same rule",
      ].join("\n"),
    );
    return 0;
  }
  const once = values.once ?? false;
  const output = openLogFiles(values["log-dir"]);
  const launchdLog = values["launchd-log"];
  rotateLogs(output, launchdLog);
  if (output !== null) log(`logging to ${output.files.out} and ${output.files.err}`);

  // One ai-worker per database, `--once` too: taken before anything reads or changes the queue.
  const lock = await takeInstanceLock(once);
  if (lock === null) return EXIT_ALREADY_RUNNING;

  const abort = new AbortController();
  // SIGTERM aborts; if the shutdown does not finish within host_worker.shutdown_grace_seconds the process logs an error and exits.
  const shutdown = installShutdown({
    log,
    abort,
    graceMs: () => loadConfig("ai").host_worker.shutdown_grace_seconds * 1000,
    exit: exitProcess,
  });

  const db = getDb();
  const activity = createActivityRecorder({ db, process: "ai-worker" });
  activity.systemRoot("system.startup").finish("ok");
  void closeStaleActivity(activity);
  const logger = createProcessLogger();
  registerBuiltinChannels(defaultRegistry);
  registerBuiltinAiSubtasks();
  registerAiControlHandlers(); // every AI-backed request kind: the single registration point

  const ai = loadConfig("ai");
  log(`started (execution: ${ai.execution}${once ? ", once" : ""}), node ${process.version}`);
  for (const [name, command] of [["claude", ai.providers.claude_cli.command], ["codex", ai.providers.codex_cli.command]] as const) {
    const found = resolveCommand(command);
    log(`${name}: ${found ?? "NOT FOUND on PATH"}`);
  }
  // The worker does not trust ai.yaml (it is editable from the web UI): say what the guards drop or refuse.
  const guardConfigs = (): Parameters<typeof configGuardFindings>[0] => {
    const configs: Parameters<typeof configGuardFindings>[0] = { ai: loadConfig("ai") };
    try {
      configs.notify = loadConfig("notify");
    } catch {
      // notify.yaml invalid: the notify step reports it
    }
    return configs;
  };
  for (const finding of configGuardFindings(guardConfigs())) log(`WARNING: ${finding.message}`);
  // A Codex older than ai.yaml providers.codex_cli.min_version only draws a warning, calls are never blocked.
  void readCodexVersion(ai.providers.codex_cli.command).then((installed) => {
    const warning = codexVersionWarning(installed, ai.providers.codex_cli.min_version);
    if (warning) log(`WARNING: ${warning}`);
  });

  const kinds = (): ReturnType<typeof aiWorkerRequestKinds> => aiWorkerRequestKinds(loadConfig("ai").execution);
  // Requests still `running` belong to a worker that died (only this worker's kinds, never the runner's). They go back
  // to the queue and run again (a deploy that restarted us must not lose a `run_ai`), up to host_worker.requeue_interrupted_max times.
  const maxRequeues = (): number => loadConfig("ai").host_worker.requeue_interrupted_max;
  // Only while holding the instance lock (taken above): another live worker's running requests are never touched.
  const orphans = await requeueInterruptedControlRequests(db, { reason: "ai-worker restarted while the request was running", maxRequeues: maxRequeues(), kinds: kinds() });
  if (orphans.requeued > 0) log(`queued ${orphans.requeued} interrupted request(s) again`);
  if (orphans.failed > 0) log(`marked ${orphans.failed} request(s) interrupted too often as failed`);
  if (orphans.requeued > 0 || orphans.failed > 0) {
    const span = activity.systemRoot("system.orphan_recovery");
    try { span.note("info", "orphans_marked", { requests_requeued: orphans.requeued, requests_failed: orphans.failed }); }
    finally { span.finish("ok"); }
  }

  if (once) {
    let handled = 0;
    let failed = 0;
    while (!abort.signal.aborted) {
      const request = await processNextControlRequest({ db, activity, signal: abort.signal, logger, kinds, maxRequeues });
      if (request === null) break;
      handled += 1;
      if (request.status === "failed") failed += 1;
      log(`request #${request.id} (${request.kind}): ${request.status} ${JSON.stringify(request.result)}`);
    }
    log(`handled ${handled} request(s), ${failed} failed`);
    await activity.close();
    await closeDb();
    await lock.release();
    shutdown.done();
    return failed > 0 ? 1 : 0;
  }

  // Hot reload: ai.yaml (execution, host_worker, providers), models.yaml (the model catalog; the router also re-reads it itself),
  // schedule.yaml (time zone), the rest the steps read. every config file, the profile files (market, languages) included;
  // each control request also re-reads the cached configs before it runs (`freshenConfig` in the poller).
  const stopWatching = watchConfig("all", (event) => log(`config ${event.name} reloaded`), {
    onError: (error) => log(`ignoring invalid config: ${error.message.split("\n")[0] ?? ""}`),
  });

  // The heartbeat is its own loop: a `run_ai` can take many minutes and must not make the worker look dead.
  // Nothing in this loop may block it. The 2026-10-08 worker wrote one heartbeat and then sat in the first disk
  // measurement (an fs call on Docker's settings under launchd that never returned): no more heartbeats, and the
  // shutdown awaited the loop forever. So the heartbeat write is time-limited and the disk measurement runs beside the loop.
  const stepMs = (): number => Math.max(1, loadConfig("ai").host_worker.step_timeout_seconds) * 1000;
  // One measurement at a time (an abandoned blocking fs call keeps its thread), the normal interval also after a failure.
  const diskChecker = createDiskChecker({
    run: () => recordHostDisk(db),
    intervalMs: () => loadConfig("ai").host_worker.disk_check_minutes * 60_000,
    timeoutMs: stepMs,
    log,
  });
  // Which shipped defaults this worker runs with (`pnpm run doctor`): written with the first heartbeat, refreshed with every
  // one after it, under the same time limit; a failure is only a warning.
  const shippedConfig = createShippedConfigReporter({ process: "ai-worker", db: () => db, log, timeoutMs: stepMs });
  const heartbeats = (async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        await withTimeout(writeHeartbeat(db, HEARTBEAT_PROCESS.aiWorker), stepMs(), "heartbeat write");
      } catch (error) {
        log(`heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      await shippedConfig.report();
      // Free space of the Docker data volume, at most every `disk_check_minutes`: the container cannot see the Mac's disk.
      diskChecker.tick();
      rotateLogs(output, launchdLog);
      // The lock lives on its own connection: after a database restart it is taken again; if another worker got it, stop.
      let state: Awaited<ReturnType<InstanceLock["check"]>> = "unknown";
      try {
        state = await withTimeout(lock.check(), stepMs(), "instance lock check");
      } catch (error) {
        log(`instance lock check failed: ${describe(error)}`);
      }
      if (state === "reacquired") log("database connection was replaced: single-instance lock taken again");
      if (state === "lost") shutdown.begin("another ai-worker took the single-instance lock", 1);
      try {
        await sleep(Math.max(1, loadConfig("ai").host_worker.heartbeat_seconds) * 1000, undefined, { signal: abort.signal });
      } catch {
        // aborted
      }
    }
  })();

  const poller = startControlLanes({
    db,
    activity,
    signal: abort.signal,
    logger,
    kinds,
    maxRequeues,
    pollSeconds: () => loadConfig("ai").host_worker.poll_seconds,
    maxPerRound: () => loadConfig("ai").host_worker.max_requests_per_poll,
  });
  log(`polling interactive and batch lanes for ${kinds().join(", ")} every ${ai.host_worker.poll_seconds}s, heartbeat every ${ai.host_worker.heartbeat_seconds}s`);

  await poller; // returns once SIGTERM / SIGINT aborted and the request in flight has finished (or was queued again)
  await heartbeats;
  stopWatching();
  await activity.close();
  await closeDb();
  await lock.release();
  shutdown.done();
  log("stopped");
  return shutdown.exitCode();
}

main().then(
  exitProcess,
  (error: unknown) => {
    log(`fatal: ${describe(error)}`);
    exitProcess(1);
  },
);
