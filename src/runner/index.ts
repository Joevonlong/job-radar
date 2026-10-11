import { setTimeout as sleep } from "node:timers/promises";

import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { createLogger } from "@/lib/channels/logger";
import type { ScheduledCycleKind } from "@/lib/channels/query";
import { defaultRegistry } from "@/lib/channels/registry";
import { createDbStateStore } from "@/lib/channels/store";
import { ensureConfigFiles, ensureProfileFiles, getConfigDir, getProfileDir, loadConfig, readConfigText, watchConfig } from "@/lib/config";
import { syncSourceRegistry } from "@/lib/sources/registry/sync";
import { closeDb, enqueueAlert, getDb, getLatestHeartbeat, pruneHeartbeats, readAppliedMigrations, writeHeartbeat, type Db } from "@/lib/db";
import { resolveMigrationsFolder, runMigrations } from "@/lib/db/migrate";
import { readJournal } from "@/lib/db/migration-journal";
import { requeueInterruptedControlRequests } from "@/lib/db/repos/control-requests";
import { failOrphanedCycles, getDbNow, type CycleKind } from "@/lib/db/repos/cycles";
import { runControlPoller, runnerRequestKinds } from "@/lib/control";
import { registerAiControlHandlers } from "@/lib/control/ai-handlers";
import { registerBuiltinAiSubtasks, registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { decideCatchUp } from "@/lib/cycle/catch-up";
import { withCycleLock } from "@/lib/cycle/lock";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { createScheduler, formatSlot } from "@/lib/cycle/schedule";
import { createSuggestScheduler, enqueueSuggestRequest, isWeeklySuggestOverdue } from "@/lib/interests/suggest-schedule";
import { loadDatabaseEnv, loadRunnerEnv } from "@/lib/env";
import {
  aiWorkerOfflineSeconds,
  applySystemRetention,
  createBackupScheduler,
  isBackupOverdue,
  migrateWithBackup,
  newestBackupTime,
  runBackup,
  takePreMigrateBackup,
  type BackupError,
} from "@/lib/ops";
import { sendAiWorkerOfflineAlert, sendCycleIncompleteAlert, startNotifyPoller } from "@/lib/notify";
import { isAckName } from "@/lib/settings/tabs";
import { createHeartbeatWatchdog } from "@/lib/ops/heartbeat-watchdog";
import { exitProcess, installShutdown } from "@/lib/ops/shutdown";
import { recordAllConfigLoaded, recordConfigLoaded } from "@/lib/settings/ack";
import { createSetupGate } from "@/lib/setup/runner-gate";

const PROCESS_NAME = "runner";
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} [runner] ${message}`);
}

/**
 * Scheduled work waits while the first-run setup is pending (a fresh install would otherwise collect with the
 * example keywords and spend channel quota). Manual requests (the control poller) always run.
 */
const setupAllows = createSetupGate(log);

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

/** Keep the `channels` table in step with the registered channels and their `enabled` switch. */
async function syncChannelRows(db: Db): Promise<number> {
  const config = loadConfig("channels");
  const rows = defaultRegistry.list().map((c) => ({
    id: c.id,
    family: c.family,
    kind: c.kind,
    enabled: defaultRegistry.isEnabled(c.id, config),
  }));
  await createDbStateStore(db).upsertChannels(rows);
  return rows.length;
}

/** Mirror config/sources.yaml into the `source_registry` table (a failure is only logged: collection does not depend on it). */
async function syncRegistry(db: Db): Promise<void> {
  try {
    const result = await syncSourceRegistry(db, { config: loadConfig("channels"), text: readConfigText("channels") });
    log(`source registry synced (${result.upserted} entries, ${result.removed} removed from the file)`);
  } catch (error) {
    log(`could not sync the source registry: ${describe(error)}`);
  }
}

/**
 * Runner entry point. Start-up order: migrations → profile files → channel rows → scheduler and
 * catch-up → heartbeat loop (until SIGTERM / SIGINT, which also cancels a running cycle).
 */
async function main(): Promise<number> {
  const env = loadRunnerEnv();
  const abort = new AbortController();

  // Bounded shutdown, same grace period as the ai-worker (ai.yaml host_worker.shutdown_grace_seconds).
  const shutdown = installShutdown({
    log,
    abort,
    graceMs: () => {
      try {
        return loadConfig("ai").host_worker.shutdown_grace_seconds * 1000;
      } catch {
        return 30_000; // ai.yaml unreadable right now: the shipped default
      }
    },
    exit: exitProcess,
  });

  log("applying migrations");
  {
    // With pending migrations on a database that has data, take a backup first; no backup, no migration.
    const { timezone, backup } = loadConfig("schedule");
    const databaseEnv = loadDatabaseEnv();
    // A dump can take minutes: keep writing the heartbeat meanwhile, so the container is not reported unhealthy (the table
    // already exists on a database that has data; a failed write is ignored, the watchdog below starts after the migrations).
    const beat = async (): Promise<void> => {
      try {
        await writeHeartbeat(getDb(), PROCESS_NAME);
      } catch {
        // not fatal
      }
    };
    const withHeartbeats = async <T>(work: () => Promise<T>): Promise<T> => {
      await beat();
      const timer = setInterval(() => void beat(), env.RUNNER_HEARTBEAT_SECONDS * 1000);
      try {
        return await work();
      } finally {
        clearInterval(timer);
      }
    };
    await migrateWithBackup({
      config: backup,
      readJournal: () => readJournal(resolveMigrationsFolder(databaseEnv.MIGRATIONS_DIR)),
      readApplied: () => readAppliedMigrations(getDb()),
      runMigrations: () => runMigrations(),
      runBackup: (label) =>
        withHeartbeats(() =>
          takePreMigrateBackup(label, {
            directory: env.RUNNER_BACKUP_DIR,
            databaseUrl: databaseEnv.DATABASE_URL,
            timeZone: timezone,
            timeoutMs: backup.timeout_minutes * 60 * 1000,
            pgDump: [env.PG_DUMP_PATH],
            pgRestore: [env.PG_RESTORE_PATH],
            backup,
            configDirs: { config: getConfigDir(), profile: getProfileDir() },
            signal: abort.signal,
          }),
        ),
      log,
    });
  }
  log("migrations up to date");

  // Copy the user config files the user directory lacks from the defaults (never overwrites). In the container the
  // user directory is read-only for the runner (the web fills it); a full directory needs no write. Must not take the runner down.
  try {
    const created = (await ensureConfigFiles()).filter((r) => r.created).map((r) => r.name);
    log(created.length > 0 ? `created user config files: ${created.join(", ")}` : "user config files present");
  } catch (error) {
    log(`could not fill the user config directory (read from the defaults meanwhile): ${describe(error)}`);
  }

  // Seeds missing profile files from <defaults>/profile.example (never overwrites). Needs a writable
  // profile mount, see compose.yaml. Failing here must not take the runner down.
  try {
    const created = (await ensureProfileFiles()).filter((r) => r.created).map((r) => r.name);
    log(created.length > 0 ? `created profile files: ${created.join(", ")}` : "profile files present");
  } catch (error) {
    log(`could not ensure profile files (is the profile directory writable?): ${describe(error)}`);
  }

  const db = getDb();
  const logger = createLogger();

  registerBuiltinChannels(defaultRegistry);
  registerBuiltinCycleSteps();
  registerBuiltinAiSubtasks();
  log(`${await syncChannelRows(db)} channel(s) registered`);
  await syncRegistry(db);

  // Nothing can be running while we hold the cycle lock: whatever is still `running` is a leftover of a crash.
  const orphans = await withCycleLock(db, "try", () => failOrphanedCycles(db, "runner restarted while the cycle was running"));
  if (orphans.acquired && (orphans.value.cycles > 0 || orphans.value.runs > 0)) {
    log(`marked ${orphans.value.cycles} unfinished cycle(s) and ${orphans.value.runs} run(s) as failed`);
    if (orphans.value.cycles > 0) {
      await sendCycleIncompleteAlert({
        db,
        logger,
        cycleId: null,
        kind: "runner",
        reason: { code: "orphaned_on_restart", count: orphans.value.cycles },
      });
    }
  }
  // A request cut off by a restart (a deploy recreating the container) runs again, up to host_worker.requeue_interrupted_max times.
  const maxRequeues = (): number => loadConfig("ai").host_worker.requeue_interrupted_max;
  if (orphans.acquired) {
    // only this process's kinds: a `run_ai` or translation the host ai-worker is working on is not an orphan
    const requests = await requeueInterruptedControlRequests(db, {
      reason: "runner restarted while the request was running",
      maxRequeues: maxRequeues(),
      kinds: runnerRequestKinds(loadConfig("ai").execution),
    });
    if (requests.requeued > 0) log(`queued ${requests.requeued} interrupted control request(s) again`);
    if (requests.failed > 0) log(`marked ${requests.failed} control request(s) interrupted too often as failed`);
  }

  const inflight = new Set<Promise<unknown>>();
  const startCycle = (kind: CycleKind, options: RunCycleOptions = {}): void => {
    log(`starting ${kind} cycle`);
    const task = runCycle(kind, { signal: abort.signal, logger, ...options }).then(
      async (result) => {
        log(`${kind} cycle ${result.cycleId ?? "-"} ${result.status} in ${result.summary.durationMs} ms`);
        if (result.status === "failed" && !abort.signal.aborted) {
          await sendCycleIncompleteAlert({ db, logger, cycleId: result.cycleId, kind, reason: { code: "cycle_failed", detail: result.summary.reason ?? null } });
        }
      },
      async (error: unknown) => {
        log(`${kind} cycle failed: ${describe(error)}`);
        if (!abort.signal.aborted) await sendCycleIncompleteAlert({ db, logger, cycleId: null, kind, reason: { code: "cycle_failed", detail: describe(error) } });
      },
    );
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  };

  const schedule = loadConfig("schedule");
  const scheduler = createScheduler({
    schedule,
    logger,
    onTrigger: (kind: ScheduledCycleKind) => {
      if (setupAllows("scheduled", `the scheduled ${kind} cycle`)) startCycle(kind);
    },
  });
  const logNextRuns = (): void => {
    const jobs = scheduler.describe();
    if (jobs.length === 0) log("no cycle is enabled in schedule.yaml");
    for (const job of jobs) {
      log(`next ${job.kind} cycle: ${job.nextRun ? formatSlot(job.nextRun, job.timezone) : "never"} [${job.cron}]`);
    }
  };
  logNextRuns();

  try {
    // one clock for the whole decision: cycle start times are stamped by Postgres, so "now" comes from there too
    const decision = await decideCatchUp(db, schedule, await getDbNow(db));
    const lastText = decision.lastCycleStartedAt ? decision.lastCycleStartedAt.toISOString() : "never";
    if (decision.disabled) {
      log("catch-up: disabled (schedule.yaml catch_up: false)");
    } else if (decision.missed && !setupAllows("catchup", `the start-up catch-up (missed ${decision.missed.kind})`)) {
      // held back: the first cycle runs once the setup is done (or from the wizard's "run the first cycle")
    } else if (decision.missed) {
      const { kind, slot } = decision.missed;
      log(`catch-up: missed ${kind} (slot ${formatSlot(slot, schedule.timezone)}), last cycle ${lastText}; running one now`);
      startCycle("catchup", { windowKind: kind });
    } else {
      log(`catch-up: nothing missed (last cycle ${lastText})`);
    }
  } catch (error) {
    log(`catch-up check failed: ${describe(error)}`);
  }

  // Daily database backup: its own cron, not a cycle step, so a slow or failed cycle never skips it.
  const backupOptions = (): Parameters<typeof runBackup>[0] => {
    const { timezone, backup } = loadConfig("schedule");
    return {
      directory: env.RUNNER_BACKUP_DIR,
      databaseUrl: loadDatabaseEnv().DATABASE_URL,
      timeZone: timezone,
      policy: { keepDaily: backup.keep_daily, keepWeekly: backup.keep_weekly },
      timeoutMs: backup.timeout_minutes * 60 * 1000,
      pgDump: [env.PG_DUMP_PATH],
      pgRestore: [env.PG_RESTORE_PATH],
      configArchive: backup.config_archive ? { dirs: { config: getConfigDir(), profile: getProfileDir() } } : null,
      signal: abort.signal,
    };
  };
  const backups = createBackupScheduler({
    config: schedule.backup,
    timeZone: schedule.timezone,
    logger,
    run: async () => {
      const result = await runBackup(backupOptions());
      // The safety backups (pre-deploy, pre-restore, premigrate) are pruned here too: only the runner is long-running with the directory mounted.
      await applySystemRetention(env.RUNNER_BACKUP_DIR, loadConfig("schedule").backup.keep_system).catch(() => undefined);
      return result;
    },
    // The notifier sends unsent `alert.*` notifications; until then the queued row and the error log line are the alert.
    onFailure: async (error: BackupError) => {
      if (error.code === "aborted") return; // the runner is shutting down: not a backup problem
      await enqueueAlert(db, { kind: "alert.backup_failed", payload: { code: error.code, message: error.message, at: new Date().toISOString() } });
    },
    // The dump is fine but its config archive is not: a low-level variant of the same alert, deduplicated by its key (once a day).
    onConfigWarning: async (warning) => {
      await enqueueAlert(db, { kind: "alert.backup_failed", payload: { key: "config_archive", code: "config_archive", message: warning, at: new Date().toISOString() } });
    },
  });
  const logNextBackup = (): void => {
    const next = backups.nextRun();
    const current = loadConfig("schedule");
    log(next ? `next backup: ${formatSlot(next, current.timezone)} [${current.backup.cron}]` : "backups are disabled in schedule.yaml");
  };
  logNextBackup();
  if (schedule.backup.enabled && schedule.catch_up) {
    try {
      const overdue = isBackupOverdue({
        now: new Date(),
        cron: schedule.backup.cron,
        timeZone: schedule.timezone,
        newestBackupAt: await newestBackupTime(env.RUNNER_BACKUP_DIR),
      });
      if (overdue) {
        log("backup: the last scheduled backup was missed; taking one now");
        const task = backups.runNow("catch-up").then(() => undefined);
        inflight.add(task);
        void task.finally(() => inflight.delete(task));
      }
    } catch (error) {
      log(`backup catch-up check failed: ${describe(error)}`);
    }
  }

  // Weekly interests suggestions: the schedule only leaves a `run_suggest` request; whoever runs AI handles it.
  const requestSuggest = async (reason: "scheduled" | "catch-up"): Promise<void> => {
    try {
      const { id, existing } = await enqueueSuggestRequest(db);
      log(existing ? `suggest (${reason}): request ${id} is already waiting` : `suggest (${reason}): queued request ${id}`);
    } catch (error) {
      log(`could not queue the suggest request: ${describe(error)}`);
    }
  };
  const suggestScheduler = createSuggestScheduler({
    config: schedule.suggest,
    timeZone: schedule.timezone,
    logger,
    onTrigger: () => (setupAllows("suggest", "the weekly suggestions") ? requestSuggest("scheduled") : undefined),
  });
  const logNextSuggest = (): void => {
    const next = suggestScheduler.nextRun();
    const current = loadConfig("schedule");
    log(next ? `next suggest run: ${formatSlot(next, current.timezone)} [${current.suggest.cron}]` : "weekly suggestions are disabled in schedule.yaml");
  };
  logNextSuggest();
  if (schedule.suggest.enabled && schedule.catch_up && setupAllows("suggest", "the suggestions catch-up")) {
    try {
      if (await isWeeklySuggestOverdue(db, schedule.suggest, schedule.timezone, new Date())) {
        log("suggest: the last weekly run was missed; asking for one now");
        await requestSuggest("catch-up");
      }
    } catch (error) {
      log(`suggest catch-up check failed: ${describe(error)}`);
    }
  }

  // Hot reload: loadConfig() serves the refreshed values; the scheduler is rebuilt here. Every config file is watched
  // (the profile files included: the market lives in preferences.yaml), and each cycle and control request also re-reads
  // the cached configs on start (`freshenConfig`), so a change is in effect even before the watcher's poll sees it.
  const stopWatching = watchConfig(
    "all",
    (event) => {
      log(`config ${event.name} reloaded`);
      // Tell the settings page which file text this runner now runs with.
      if (isAckName(event.name)) {
        recordConfigLoaded(db, event.name, event.text).catch((error: unknown) => log(`could not record config ${event.name} as loaded: ${describe(error)}`));
      }
      if (event.name === "schedule") {
        const next = loadConfig("schedule");
        scheduler.reschedule(next);
        logNextRuns();
        backups.reschedule(next.backup, next.timezone);
        logNextBackup();
        suggestScheduler.reschedule(next.suggest, next.timezone);
        logNextSuggest();
      } else if (event.name === "channels") {
        syncChannelRows(db).catch((error: unknown) => log(`could not sync channel rows: ${describe(error)}`));
        void syncRegistry(db);
      }
    },
    { onError: (error) => log(`ignoring invalid config: ${error.message.split("\n")[0] ?? ""}`) },
  );

  // Telegram long-polling (inline buttons + the daily reminder); idles while notify.yaml has it disabled.
  const poller = startNotifyPoller({ db, logger, signal: abort.signal });
  log(poller ? "telegram poller started" : "telegram poller not started (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)");

  try {
    await recordAllConfigLoaded(db);
  } catch (error) {
    log(`could not record the loaded config: ${describe(error)}`);
  }

  // Requests from the web app (manual cycle, re-score, translation): polled from `control_requests`, no port needed.
  // The AI ones are only claimed here with `ai.yaml: execution: container`; with `host` the ai-worker takes them.
  registerAiControlHandlers();
  const controlPoller = runControlPoller({
    db,
    signal: abort.signal,
    logger,
    kinds: () => runnerRequestKinds(loadConfig("ai").execution),
    maxRequeues,
    pollSeconds: () => loadConfig("schedule").control_poll_seconds,
  });
  log(`polling control requests every ${loadConfig("schedule").control_poll_seconds}s`);

  // With `execution: host` the AI and the push run in the ai-worker. When it stops, nothing there can say so: the
  // runner (which still has the Telegram credentials) raises the alert. Deduped by `notify.yaml: alerts.dedupe_hours`.
  const watchingSince = await getDbNow(db);
  const watchAiWorker = async (): Promise<void> => {
    try {
      const ai = loadConfig("ai");
      if (ai.execution !== "host") return;
      const now = await getDbNow(db);
      const offlineSeconds = aiWorkerOfflineSeconds({
        execution: ai.execution,
        lastHeartbeatAt: (await getLatestHeartbeat(db, "ai-worker"))?.at ?? null,
        since: watchingSince,
        now,
        offlineAfterSeconds: ai.host_worker.offline_after_seconds,
      });
      if (offlineSeconds !== null) {
        log(`ai-worker has not sent a heartbeat for ${offlineSeconds}s`);
        await sendAiWorkerOfflineAlert({ db, logger, offlineSeconds });
      }
    } catch (error) {
      log(`ai-worker check failed: ${describe(error)}`);
    }
  };

  const intervalMs = env.RUNNER_HEARTBEAT_SECONDS * 1000;
  const retentionMs = env.RUNNER_HEARTBEAT_RETENTION_HOURS * 60 * 60 * 1000;
  let lastPruneAt = 0;
  const watchdog = createHeartbeatWatchdog({ maxFailureSeconds: env.RUNNER_HEALTH_MAX_AGE_SECONDS * 2 });

  log(`heartbeat every ${env.RUNNER_HEARTBEAT_SECONDS}s`);
  while (!abort.signal.aborted) {
    try {
      await writeHeartbeat(db, PROCESS_NAME);
      watchdog.succeeded();
      if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
        const pruned = await pruneHeartbeats(db, new Date(Date.now() - retentionMs));
        lastPruneAt = Date.now();
        if (pruned > 0) log(`pruned ${pruned} old heartbeats`);
      }
    } catch (error) {
      // A transient database error must not kill the runner; the stale heartbeat is the signal.
      log(`heartbeat failed: ${error instanceof Error ? error.name : "unknown error"}`);
      // ...but not forever: Docker restarts a container that exits, not one that is merely unhealthy (ARCH-5).
      if (watchdog.failed()) {
        log(`no heartbeat could be written for ${env.RUNNER_HEALTH_MAX_AGE_SECONDS * 2}s; exiting so that Docker restarts the runner`);
        exitProcess(1);
      }
    }
    await watchAiWorker();
    try {
      await sleep(intervalMs, undefined, { signal: abort.signal });
    } catch {
      // aborted: leave the loop
    }
  }

  scheduler.stop();
  backups.stop();
  suggestScheduler.stop();
  stopWatching();
  if (poller) {
    log("waiting for the telegram poller to stop");
    await poller.catch((error: unknown) => log(`telegram poller ended with an error: ${describe(error)}`));
  }
  await controlPoller;
  if (inflight.size > 0) {
    log(`waiting for ${inflight.size} running cycle(s) to stop`);
    await Promise.allSettled([...inflight]);
  }
  await closeDb();
  shutdown.done();
  log("stopped");
  return shutdown.exitCode();
}

main().then(
  exitProcess,
  (error: unknown) => {
    log(`fatal: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    exitProcess(1);
  },
);
