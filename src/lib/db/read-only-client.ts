import { loadDatabaseEnv } from "@/lib/env";

import { createConnection, QUERY_SESSION_SETTINGS, type Db } from "./client";

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
 * JIT is off as on the web pool (QUERY_SESSION_SETTINGS): MCP search_jobs runs the same search queries. Every user of this
 * pool gets those settings: the MCP server (`scripts/mcp-serve.ts`) and `scripts/deliveries-show.ts`; their short lookups gain
 * nothing from JIT either. The dry run of `scripts/cycle-run.ts` uses the read-only shared pool instead (`initializeReadOnlyDb`).
 */
export function createReadOnlyDb(options: { url?: string; connectTimeoutSeconds?: number; max?: number } = {}): ReadOnlyDb {
  const url = options.url ?? loadDatabaseEnv().DATABASE_URL;
  const { db, sql } = createConnection(url, {
    max: options.max ?? READ_ONLY_POOL_MAX,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
    readOnly: true,
    sessionSettings: QUERY_SESSION_SETTINGS,
  });
  return { db, close: () => sql.end({ timeout: 5 }) };
}
