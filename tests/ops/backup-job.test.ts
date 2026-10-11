// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { BackupError, type BackupResult } from "@/lib/ops/backup";
import { createBackupScheduler, isBackupOverdue } from "@/lib/ops/backup-job";

const CRON = "30 3 * * *";
const TZ = "Europe/Berlin";
const quiet = createLogger({ sink: () => {} });

describe("isBackupOverdue", () => {
  const now = new Date("2026-10-07T07:00:00Z"); // 09:00 Berlin; today's slot was 03:30 Berlin = 01:30 UTC

  it("is overdue when there is no backup at all", () => {
    expect(isBackupOverdue({ now, cron: CRON, timeZone: TZ, newestBackupAt: null })).toBe(true);
  });

  it("is overdue when the newest backup is older than the latest slot", () => {
    expect(isBackupOverdue({ now, cron: CRON, timeZone: TZ, newestBackupAt: new Date("2026-10-06T01:31:00Z") })).toBe(true);
  });

  it("is not overdue once a backup is at or after the latest slot", () => {
    expect(isBackupOverdue({ now, cron: CRON, timeZone: TZ, newestBackupAt: new Date("2026-10-07T01:30:00Z") })).toBe(false);
    expect(isBackupOverdue({ now, cron: CRON, timeZone: TZ, newestBackupAt: new Date("2026-10-07T01:30:20Z") })).toBe(false);
  });

  it("is not overdue before the first slot of the day has been missed", () => {
    // 01:00 Berlin: the latest slot is yesterday's 03:30
    expect(
      isBackupOverdue({
        now: new Date("2026-10-06T23:00:00Z"),
        cron: CRON,
        timeZone: TZ,
        newestBackupAt: new Date("2026-10-06T01:31:00Z"),
      }),
    ).toBe(false);
  });
});

const result = (file = "jobradar-20261007-033000.dump"): BackupResult => ({
  file,
  path: `/x/${file}`,
  bytes: 10,
  durationMs: 5,
  removed: [],
  removeFailed: [],
  configFile: "jobradar-20261007-033000.config.tgz",
  configWarning: null,
});

const config = { enabled: true, cron: CRON, keep_daily: 14, keep_weekly: 8, timeout_minutes: 30, config_archive: true, pre_migrate: true, keep_system: 5, keep_old_databases: 1 };

describe("createBackupScheduler", () => {
  it("runs a backup and reports the result", async () => {
    const run = vi.fn(async () => result());
    const onFailure = vi.fn();
    const scheduler = createBackupScheduler({ config, timeZone: TZ, logger: quiet, run, onFailure });
    try {
      expect(await scheduler.runNow("scheduled")).toEqual(result());
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it("reports a failed config archive to onConfigWarning, swallows the hook's own error, and still counts the run as done", async () => {
    const warned = result();
    warned.configFile = null;
    warned.configWarning = "could not write the config archive (ENOSPC)";
    const onConfigWarning = vi.fn(async () => {
      throw new Error("hook broke");
    });
    const onFailure = vi.fn();
    const scheduler = createBackupScheduler({ config, timeZone: TZ, logger: quiet, run: async () => warned, onFailure, onConfigWarning });
    try {
      expect(await scheduler.runNow("scheduled")).toEqual(warned);
      expect(onConfigWarning).toHaveBeenCalledWith("could not write the config archive (ENOSPC)", warned);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it("never throws: a failure goes to onFailure and the next run still happens", async () => {
    const run = vi.fn<() => Promise<BackupResult>>().mockRejectedValueOnce(new BackupError("pg_dump exited with code 1", "pg_dump_failed")).mockResolvedValue(result());
    const onFailure = vi.fn();
    const scheduler = createBackupScheduler({ config, timeZone: TZ, logger: quiet, run, onFailure });
    try {
      expect(await scheduler.runNow("scheduled")).toBeNull();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ code: "pg_dump_failed" });
      expect(await scheduler.runNow("scheduled")).toEqual(result());
    } finally {
      scheduler.stop();
    }
  });

  it("wraps unexpected errors without leaking their message", async () => {
    const onFailure = vi.fn();
    const scheduler = createBackupScheduler({
      config,
      timeZone: TZ,
      logger: quiet,
      run: async () => {
        throw new Error("postgres://user:secret@db/x exploded");
      },
      onFailure,
    });
    try {
      await scheduler.runNow("scheduled");
      const error = onFailure.mock.calls[0]?.[0] as BackupError;
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).not.toContain("secret");
    } finally {
      scheduler.stop();
    }
  });

  it("survives a failing failure hook", async () => {
    const scheduler = createBackupScheduler({
      config,
      timeZone: TZ,
      logger: quiet,
      run: async () => {
        throw new BackupError("boom", "io");
      },
      onFailure: async () => {
        throw new Error("hook down");
      },
    });
    try {
      await expect(scheduler.runNow("scheduled")).resolves.toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it("does not start a second backup while one is running", async () => {
    let release: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<BackupResult>((resolve) => {
          release = () => resolve(result());
        }),
    );
    const scheduler = createBackupScheduler({ config, timeZone: TZ, logger: quiet, run, onFailure: vi.fn() });
    try {
      const first = scheduler.runNow("scheduled");
      expect(await scheduler.runNow("catch-up")).toBeNull();
      release();
      expect(await first).toEqual(result());
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });

  it("schedules the configured cron in the schedule's zone and follows a reschedule", () => {
    const scheduler = createBackupScheduler({ config, timeZone: TZ, logger: quiet, run: async () => result(), onFailure: vi.fn() });
    try {
      const next = scheduler.nextRun();
      expect(next).toBeInstanceOf(Date);
      const berlinTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next as Date);
      expect(berlinTime).toBe("03:30");

      scheduler.reschedule({ ...config, cron: "15 4 * * *" }, "UTC");
      expect(new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(scheduler.nextRun() as Date)).toBe("04:15");

      scheduler.reschedule({ ...config, enabled: false }, TZ);
      expect(scheduler.nextRun()).toBeNull();
    } finally {
      scheduler.stop();
    }
  });
});
