import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { loadDatabaseEnv } from "@/lib/env";

import * as schema from "./schema";
import { assertTestDatabase } from "./test-guard";

export type Db = PostgresJsDatabase<typeof schema>;

interface Connection {
  sql: Sql;
  db: Db;
}

/**
 * Lazy singleton pool. Stored on `globalThis` so Next.js dev-mode module reloads
 * do not open a new pool on every edit.
 */
const globalForDb = globalThis as typeof globalThis & { __jobRadarDb?: Connection; __jobRadarDbUrls?: WeakMap<Db, string> };
const connectionUrls = globalForDb.__jobRadarDbUrls ??= new WeakMap<Db, string>();

/** Connection metadata for database helpers that need a dedicated session against the same database as this pool. */
export function databaseUrlFor(db: Db): string {
  const url = connectionUrls.get(db);
  if (!url) throw new Error("a dedicated session requires a database pool created by createConnection");
  return url;
}

/** Create an independent connection (used by the singleton, migrations and tests). */
export function createConnection(url: string, options: { max?: number; connectTimeoutSeconds?: number; readOnly?: boolean; sessionSettings?: Record<string, string | number> } = {}): Connection {
  // Under Vitest only a disposable test database may be opened
  assertTestDatabase(url);
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Fail fast instead of hanging when the database is unreachable (DB_CONNECT_TIMEOUT_SECONDS, default 5).
    connect_timeout: options.connectTimeoutSeconds ?? connectTimeoutFromEnv(),
    idle_timeout: 30,
    onnotice: () => {},
    // read-only tools: the server itself refuses every write in this session
    connection: { ...options.sessionSettings, ...(options.readOnly ? { default_transaction_read_only: true } : {}) },
  });
  const db = drizzle(sql, { schema });
  connectionUrls.set(db, url);
  return { sql, db };
}

/** DB_CONNECT_TIMEOUT_SECONDS for connections created without an explicit timeout (tests, scripts); 5 when unset or invalid. */
export function connectTimeoutFromEnv(): number {
  const value = Number(process.env.DB_CONNECT_TIMEOUT_SECONDS);
  return Number.isInteger(value) && value >= 1 && value <= 120 ? value : 5;
}

function getConnection(): Connection {
  if (!globalForDb.__jobRadarDb) {
    const env = loadDatabaseEnv();
    globalForDb.__jobRadarDb = createConnection(env.DATABASE_URL, { max: env.DB_POOL_MAX, connectTimeoutSeconds: env.DB_CONNECT_TIMEOUT_SECONDS });
  }
  return globalForDb.__jobRadarDb;
}

/** Typed Drizzle handle backed by the shared pool. */
export function getDb(): Db {
  return getConnection().db;
}

/** Shared pool handle only for repositories that need native Sql. */
export function getSql(): Sql {
  return getConnection().sql;
}

/** Close the shared pool (graceful shutdown, tests). Safe to call when never opened. */
export async function closeDb(): Promise<void> {
  const connection = globalForDb.__jobRadarDb;
  globalForDb.__jobRadarDb = undefined;
  if (connection) {
    await connection.sql.end({ timeout: 5 });
  }
}
