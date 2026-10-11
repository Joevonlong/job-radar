import type { MigrationJournal } from "@/lib/db/migration-journal";

import { applySystemRetention, runBackup, type BackupResult } from "./backup";
import type { ConfigArchiveDirs } from "./config-archive";
import { formatManualBackupName } from "./retention";

/** Label of the safety backup taken before migrations: `premigrate-<applied>-<shipped>`. */
export function preMigrateLabel(applied: number, shipped: number): string {
  return `premigrate-${applied}-${shipped}`;
}

export interface MigrateWithBackupDeps {
  /** `schedule.yaml: backup.pre_migrate`. */
  config: { pre_migrate: boolean };
  /** What this checkout ships (null: the journal is unreadable, so there is nothing to compare). */
  readJournal: () => Promise<MigrationJournal | null>;
  /** What the database has applied (`count` 0 for a database that was never migrated). */
  readApplied: () => Promise<{ count: number; latestAt?: number | null }>;
  /** Takes the backup with this label; throws when it fails. */
  runBackup: (label: string) => Promise<{ file: string }>;
  runMigrations: () => Promise<void>;
  log?: (message: string) => void;
}

export interface MigrateWithBackupResult {
  /** File name of the backup that was taken first, or null when none was needed. */
  backup: string | null;
  applied: number;
  shipped: number | null;
}

/** The runner exits (and restarts) rather than migrate without the promised backup; the message names the way out. */
export class PreMigrateBackupError extends Error {
  constructor(cause: unknown) {
    super(
      `the backup before the database migration failed, so nothing was migrated: ${cause instanceof Error ? cause.message : "unexpected error"}. ` +
        "Fix the cause (docker compose logs runner, free disk space) or set backup.pre_migrate: false in schedule.yaml to migrate without a backup",
    );
    this.name = "PreMigrateBackupError";
  }
}

/**
 * Apply pending migrations, but first take a backup when the database already has data and this checkout ships more
 * migrations than it has applied. A brand-new database (nothing applied) has nothing to lose and is not backed up.
 * When the backup fails nothing is migrated.
 */
export async function migrateWithBackup(deps: MigrateWithBackupDeps): Promise<MigrateWithBackupResult> {
  const log = deps.log ?? (() => undefined);
  const [journal, applied] = await Promise.all([deps.readJournal(), deps.readApplied()]);
  // More migrations than applied, or a newer newest migration (the count alone misses a replaced/renumbered one).
  const newerThanApplied = journal !== null && journal.latestAt !== null && applied.latestAt != null && journal.latestAt > applied.latestAt;
  const pending = journal !== null && applied.count > 0 && (journal.count > applied.count || newerThanApplied);
  let backup: string | null = null;
  if (pending && deps.config.pre_migrate) {
    log(`backing up before applying database migrations (${applied.count} applied, ${journal.count} shipped)`);
    try {
      backup = (await deps.runBackup(preMigrateLabel(applied.count, journal.count))).file;
    } catch (error) {
      throw new PreMigrateBackupError(error);
    }
    log(`pre-migration backup written: ${backup}`);
  } else if (pending) {
    log("backup.pre_migrate is off: migrating without a backup");
  }
  await deps.runMigrations();
  return { backup, applied: applied.count, shipped: journal?.count ?? null };
}

export interface PreMigrateBackupSetup {
  directory: string;
  databaseUrl: string;
  timeZone: string;
  timeoutMs: number;
  pgDump: readonly string[];
  pgRestore: readonly string[];
  /** The `schedule.yaml: backup` keys this uses. */
  backup: { config_archive: boolean; keep_system: number };
  configDirs: ConfigArchiveDirs;
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * The backup `migrateWithBackup` takes: a manual-style `jobradar-manual-<stamp>-premigrate-<from>-<to>.dump` (restore.sh
 * `--latest` / `--list` know it; the daily retention never matches it) with the config archive, then at most
 * `keep_system` of each kind of safety backup stay.
 */
export async function takePreMigrateBackup(label: string, setup: PreMigrateBackupSetup): Promise<BackupResult> {
  const now = setup.now ?? (() => new Date());
  const result = await runBackup({
    directory: setup.directory,
    databaseUrl: setup.databaseUrl,
    timeZone: setup.timeZone,
    policy: { keepDaily: 1, keepWeekly: 0 },
    timeoutMs: setup.timeoutMs,
    pgDump: setup.pgDump,
    pgRestore: setup.pgRestore,
    fileName: formatManualBackupName(now(), setup.timeZone, label),
    applyRetention: false,
    configArchive: setup.backup.config_archive ? { dirs: setup.configDirs } : null,
    signal: setup.signal,
    now,
  });
  // The new backup is safe: a pruning problem must not stop the migration.
  await applySystemRetention(setup.directory, setup.backup.keep_system).catch(() => undefined);
  return result;
}
