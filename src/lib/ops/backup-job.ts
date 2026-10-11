import { Cron } from "croner";

import type { ChannelLogger } from "@/lib/channels/types";
import type { BackupConfig } from "@/lib/config";
import { latestSlotAtOrBefore } from "@/lib/cycle/schedule";

import { BackupError, listBackups, type BackupResult } from "./backup";

/**
 * True when the backup job missed its latest slot: that slot is at or before `now` and no backup is
 * newer than it. `newestBackupAt` is the modification time of the newest backup file (null: none yet).
 */
export function isBackupOverdue(input: { now: Date; cron: string; timeZone: string; newestBackupAt: Date | null }): boolean {
  const slot = latestSlotAtOrBefore(input.cron, input.timeZone, input.now);
  if (slot === null) return false;
  return input.newestBackupAt === null || input.newestBackupAt.getTime() < slot.getTime();
}

/** Modification time of the newest scheduled backup in `directory`, or null. */
export async function newestBackupTime(directory: string): Promise<Date | null> {
  const files = await listBackups(directory);
  return files.reduce<Date | null>((newest, file) => (newest === null || file.modifiedAt > newest ? file.modifiedAt : newest), null);
}

/** What the scheduler reads of `schedule.yaml: backup` (`max_age_hours` is only for `pnpm run doctor`). */
export type BackupJobConfig = Omit<BackupConfig, "max_age_hours">;

export interface BackupSchedulerOptions {
  config: BackupJobConfig;
  timeZone: string;
  logger: ChannelLogger;
  /** Takes the dump and applies retention (runBackup bound to the runner's settings). */
  run: () => Promise<BackupResult>;
  /** Called after every failed run (the notifier turns this into an alert). Its own errors are logged and swallowed. */
  onFailure: (error: BackupError) => void | Promise<void>;
  /** Called when the dump succeeded but its config archive did not (`result.configWarning`). Its own errors are logged and swallowed. */
  onConfigWarning?: (warning: string, result: BackupResult) => void | Promise<void>;
}

export interface BackupScheduler {
  /** Replace the job with one built from the new config (hot reload). */
  reschedule(config: BackupJobConfig, timeZone: string): void;
  /** One backup right now; never throws, failures go through `onFailure`. Returns the result or null. */
  runNow(reason: "scheduled" | "catch-up"): Promise<BackupResult | null>;
  nextRun(): Date | null;
  stop(): void;
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  let job: Cron | null = null;
  let running = false;

  const runNow = async (reason: "scheduled" | "catch-up"): Promise<BackupResult | null> => {
    if (running) {
      options.logger.warn("backup skipped: the previous one is still running", { reason });
      return null;
    }
    running = true;
    try {
      const result = await options.run();
      options.logger.info("backup finished", {
        reason,
        file: result.file,
        bytes: result.bytes,
        durationMs: result.durationMs,
        removed: result.removed.length,
        removeFailed: result.removeFailed.length,
        configFile: result.configFile,
      });
      if (result.configWarning !== null) {
        options.logger.warn("backup: the database dump is complete but the config archive failed", { file: result.file, error: result.configWarning });
        try {
          await options.onConfigWarning?.(result.configWarning, result);
        } catch (hookError) {
          options.logger.error("backup warning hook failed", { error: hookError instanceof Error ? hookError.name : "unknown error" });
        }
      }
      return result;
    } catch (error) {
      const failure = error instanceof BackupError ? error : new BackupError("backup failed: unexpected error", "io");
      options.logger.error("backup failed", { reason, code: failure.code, error: failure.message });
      try {
        await options.onFailure(failure);
      } catch (hookError) {
        options.logger.error("backup failure hook failed", { error: hookError instanceof Error ? hookError.name : "unknown error" });
      }
      return null;
    } finally {
      running = false;
    }
  };

  const start = (config: BackupJobConfig, timeZone: string): void => {
    if (!config.enabled) return;
    job = new Cron(config.cron, { timezone: timeZone, protect: true, catch: () => {} }, async () => {
      await runNow("scheduled");
    });
  };
  start(options.config, options.timeZone);

  return {
    reschedule(config, timeZone) {
      job?.stop();
      job = null;
      start(config, timeZone);
    },
    runNow,
    nextRun: () => job?.nextRun() ?? null,
    stop() {
      job?.stop();
      job = null;
    },
  };
}
