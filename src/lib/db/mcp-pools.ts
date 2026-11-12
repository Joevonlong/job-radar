/** Dedicated, lazy HTTP MCP pools survive dev reloads; pool sizes and audit timeouts take effect when they first open. */
import { createAuditRecorder, type AuditRecorder, type AuditConnection } from "@/lib/agent-access/audit";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { loadDatabaseEnv } from "@/lib/env";
import { stderrLine } from "@/lib/mcp/call-log";
import { mcpTranslator } from "@/lib/mcp/text";

import { createConnection, QUERY_SESSION_SETTINGS, type Db } from "./client";
import { createReadOnlyDb, type ReadOnlyDb } from "./read-only-client";
import { openAgentCallsConnection } from "./repos/agent-calls";

interface McpPools {
  read?: ReadOnlyDb;
  write?: ReturnType<typeof createConnection>;
  audit?: AuditRecorder;
}

const globalForMcp = globalThis as typeof globalThis & { __jobRadarMcpPools?: McpPools };
const pools = (): McpPools => globalForMcp.__jobRadarMcpPools ??= {};

export function getMcpReadDb(settings: McpConfig): Db {
  return (pools().read ??= createReadOnlyDb({ max: settings.http.pool.read_max })).db;
}

export function getMcpWriteDb(settings: McpConfig): Db {
  return (pools().write ??= createConnection(loadDatabaseEnv().DATABASE_URL, {
    max: settings.http.pool.write_max,
    sessionSettings: QUERY_SESSION_SETTINGS,
  })).db;
}

export function openMcpAuditConnection(settings: McpConfig["audit"]): AuditConnection {
  const connection = openAgentCallsConnection(loadDatabaseEnv().DATABASE_URL, {
    connectTimeoutSeconds: settings.connect_timeout_seconds,
    statementTimeoutMs: settings.statement_timeout_ms,
    lockTimeoutMs: settings.lock_timeout_ms,
  });
  return { db: connection.db, end: (options) => connection.sql.end(options) };
}

export function getMcpAuditRecorder(settings: McpConfig): AuditRecorder {
  return pools().audit ??= createAuditRecorder(() => openMcpAuditConnection(settings.audit), {
    text: mcpTranslator(), log: stderrLine, writeTimeoutMs: settings.audit.write_timeout_ms,
  });
}

export async function closeMcpPools(): Promise<void> {
  const current = globalForMcp.__jobRadarMcpPools;
  globalForMcp.__jobRadarMcpPools = undefined;
  await current?.audit?.close();
  await Promise.all([current?.read?.close(), current?.write?.sql.end({ timeout: 5 })]);
}
