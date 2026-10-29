import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { loadDatabaseEnv } from "@/lib/env";

import { connectTimeoutFromEnv, QUERY_SESSION_SETTINGS, type Db } from "./client";
import * as schema from "./schema";
import { assertTestDatabase } from "./test-guard";

/** Connections of a read-only process (one tool call runs a handful of queries in parallel). */
const READ_ONLY_POOL_MAX = 3;

export interface ReadOnlyDb {
  db: Db;
  /** Close the pool (the process is ending). */
  close(): Promise<void>;
}

/**
 * A connection pool whose sessions start read-only (`default_transaction_read_only`): any INSERT / UPDATE / DELETE / DDL fails with
 * 25006 `read_only_sql_transaction`. A guard against a mistaken write, not a security boundary (a session could still open a
 * `BEGIN READ WRITE` transaction); the boundary of a read-only process is that it has no code path that writes. A Postgres role
 * with SELECT rights only is the optional hardening (docs/mcp.md). The handle is the ordinary `Db`, so every query function works.
 * JIT is off as on the web pool (QUERY_SESSION_SETTINGS): MCP search_jobs runs the same search queries.
 */
export function createReadOnlyDb(options: { url?: string; connectTimeoutSeconds?: number } = {}): ReadOnlyDb {
  const url = options.url ?? loadDatabaseEnv().DATABASE_URL;
  assertTestDatabase(url);
  const sql = postgres(url, {
    max: READ_ONLY_POOL_MAX,
    connect_timeout: options.connectTimeoutSeconds ?? connectTimeoutFromEnv(),
    idle_timeout: 30,
    onnotice: () => {},
    connection: { ...QUERY_SESSION_SETTINGS, default_transaction_read_only: true },
  });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
