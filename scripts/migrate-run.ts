/**
 * pnpm migrate:run — apply pending migrations to the compose database from the host (the same `runMigrations` the runner
 * calls at start-up; idempotent). scripts/ops/deploy.sh runs it after the stack is up. DATABASE_URL is used when set, otherwise
 * it is built from the POSTGRES_* / DB_HOST_PORT values of .env, like `pnpm run doctor` does. Prints the result, never the URL.
 * With pending migrations on a database that has data it first writes data/backups/jobradar-manual-<stamp>-premigrate-<from>-<to>.dump
 * (schedule.yaml backup.pre_migrate); when that backup fails nothing is migrated.
 */
import path from "node:path";

import { getAppRoot, getConfigDir, getProfileDir, loadConfig } from "../src/lib/config";
import { closeDb, getDb, readAppliedMigrations } from "../src/lib/db";
import { resolveMigrationsFolder, runMigrations } from "../src/lib/db/migrate";
import { readJournal } from "../src/lib/db/migration-journal";
import { resolveHostDatabaseUrl } from "../src/lib/ops/doctor/database-url";
import { redact } from "../src/lib/ops/doctor/helpers";
import { resolveHostPgTools } from "../src/lib/ops/host-pg-tools";
import { migrateWithBackup, takePreMigrateBackup } from "../src/lib/ops/pre-migrate-backup";

async function main(): Promise<number> {
  const url = resolveHostDatabaseUrl(process.env);
  process.env.DATABASE_URL = url;
  const before = await readAppliedMigrations(getDb());
  const { timezone, backup } = loadConfig("schedule");
  const root = getAppRoot();
  const tools = await resolveHostPgTools({ databaseUrl: url, composeDir: root });
  await migrateWithBackup({
    config: backup,
    readJournal: () => readJournal(resolveMigrationsFolder(process.env.MIGRATIONS_DIR)),
    readApplied: async () => before,
    runMigrations: () => runMigrations({ url }),
    runBackup: (label) =>
      takePreMigrateBackup(label, {
        directory: path.join(root, "data", "backups"),
        databaseUrl: tools.databaseUrl,
        timeZone: timezone,
        timeoutMs: backup.timeout_minutes * 60 * 1000,
        pgDump: tools.pgDump,
        pgRestore: tools.pgRestore,
        backup,
        configDirs: { config: getConfigDir(), profile: getProfileDir() },
      }),
    log: (message) => console.log(`migrate:run: ${message}`),
  });
  const after = await readAppliedMigrations(getDb());
  console.log(after.count === before.count ? `migrations up to date (${after.count} applied)` : `migrations applied: ${before.count} -> ${after.count}`);
  return 0;
}

main().then(
  async (code) => {
    await closeDb();
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`migrate:run: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  },
);
