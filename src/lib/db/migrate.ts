import path from "node:path";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { loadDatabaseEnv } from "@/lib/env";

import { createConnection } from "./client";

/** The folder with the SQL files and `meta/_journal.json`: the given path (`MIGRATIONS_DIR`), else `drizzle`, relative to the working directory. */
export function resolveMigrationsFolder(configured?: string): string {
  return path.resolve(configured ?? "drizzle");
}

/**
 * Apply pending migrations. Idempotent: drizzle records applied migrations in
 * `drizzle.__drizzle_migrations` and skips them on re-runs.
 *
 * Uses its own single-connection client so the migration never competes with the pool.
 * `MIGRATIONS_DIR` (default `drizzle`, relative to the working directory) locates the SQL files.
 */
export async function runMigrations(options: { url?: string; migrationsFolder?: string; currentScoresBackfill: { lockTimeoutMs: number; statementTimeoutMs: number } }): Promise<void> {
  const env = loadDatabaseEnv(options.url ? { ...process.env, DATABASE_URL: options.url } : process.env);
  const folder = resolveMigrationsFolder(options.migrationsFolder ?? env.MIGRATIONS_DIR);

  const connection = createConnection(env.DATABASE_URL, { max: 1 });
  try {
    const { lockTimeoutMs, statementTimeoutMs } = options.currentScoresBackfill;
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || !Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1000) throw new Error("Invalid current score backfill timeouts");
    await connection.sql`select set_config('job_radar.current_scores_backfill_lock_timeout_ms', ${String(lockTimeoutMs)}, false),
      set_config('job_radar.current_scores_backfill_statement_timeout_ms', ${String(statementTimeoutMs)}, false)`;
    await migrate(connection.db, { migrationsFolder: folder });
  } finally {
    await connection.sql.end({ timeout: 5 });
  }
}
