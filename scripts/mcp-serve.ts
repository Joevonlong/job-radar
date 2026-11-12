/**
 * The MCP server over stdio (docs/mcp.md): an MCP client you configure (Claude Desktop, Claude Code, ...) starts this as a child
 * process and talks to it on stdin / stdout. No port is opened. Tool calls write metadata-only audit rows;
 * write capabilities use a separate connection, granted only for their effective write permissions. Permitted action
 * triggers use another single-session write connection for budgets and the existing control queue.
 *
 *   scripts/mcp-stdio.sh   (from any directory; or `pnpm --silent mcp:serve` inside the project)
 *
 * Off by default: with mcp.yaml `enabled: false` (or no available tool permissions, or an unreadable mcp.yaml) it says why on stderr and
 * exits with 1, which the client shows in its log. stdout carries protocol messages only; every other line goes to stderr.
 * Settings are re-read on every call: disabling mcp.yaml (or removing a permission, or breaking the file) refuses the next call without a restart.
 * When the client goes away it waits at most mcp.yaml `audit.write_timeout_ms` for running calls and their audit rows, then closes
 * the database connections, giving a query that is still running at most 5 seconds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { authorize, liveMcpSettings } from "../src/lib/agent-access/authorize";
import { createAuditRecorder } from "../src/lib/agent-access/audit";
import { CAPABILITIES, visibleCapabilities } from "../src/lib/capabilities/registry";
import { closeDb, createConnection, initializeReadOnlyDb } from "../src/lib/db/client";
import { createReadOnlyDb } from "../src/lib/db/read-only-client";
import { openAgentCallsConnection } from "../src/lib/db/repos/agent-calls";
import { loadDatabaseEnv } from "../src/lib/env";
import { stderrLine } from "../src/lib/mcp/call-log";
import { buildServer, defaultContext } from "../src/lib/mcp/server";
import { configProblem, readMcpSettings } from "../src/lib/mcp/settings";
import { mcpTranslator } from "../src/lib/mcp/text";
import { readWriterEnabled, readWriterInputs } from "../src/lib/writer/settings";

// stdout belongs to the protocol: anything a library logs goes to stderr instead
console.log = console.error;
console.info = console.error;
console.debug = console.error;

function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
    return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The write connection is decided before the offered list, because the writing tool is offered only when it has one: it is opened
 * when tracking:write is permitted, or writer:write is permitted and writer.yaml is on. Switching it on later needs a restart.
 */
async function main(): Promise<void> {
  const text = mcpTranslator();
  let settings;
  try {
    settings = readMcpSettings();
  } catch (error) {
    stderrLine(text("serve.configError", { problem: configProblem(error) }));
    process.exit(1);
  }
  if (!settings.enabled) {
    stderrLine(text("serve.disabled"));
    process.exit(1);
  }
  const writerWrites = readWriterEnabled() && authorize({ id: "save_application_answer", permission: "writer:write" }, liveMcpSettings).allowed;
  const trackingWrites = authorize({ id: "set_application_status", permission: "tracking:write" }, liveMcpSettings).allowed;
  const writes = writerWrites || trackingWrites;
  const writable = writes ? createConnection(loadDatabaseEnv().DATABASE_URL, { max: 1 }) : null;
  const writerDb = writerWrites ? writable?.db ?? null : null;
  const trackingDb = trackingWrites ? writable?.db ?? null : null;
  const actionWrites = CAPABILITIES.some((capability) => capability.kind === "trigger" && authorize(capability, liveMcpSettings).allowed);
  const actionConnection = actionWrites ? createConnection(loadDatabaseEnv().DATABASE_URL, { max: 1 }) : null;
  const tools = (await visibleCapabilities(CAPABILITIES, { readSettings: liveMcpSettings, writer: { inputs: readWriterInputs, writeDb: writerDb }, tracking: { writeDb: trackingDb }, actions: actionConnection ? { db: actionConnection.db } : undefined })).map(
    (capability) => capability.id,
  );
  if (tools.length === 0) {
    stderrLine(text("serve.noTools"));
    await Promise.allSettled([...(writable ? [writable.sql.end()] : []), ...(actionConnection ? [actionConnection.sql.end()] : [])]);
    process.exit(1);
  }

  initializeReadOnlyDb();
  const database = createReadOnlyDb();
  const { audit: auditSettings } = settings;
  const openAudit = () => {
    const connection = openAgentCallsConnection(loadDatabaseEnv().DATABASE_URL, {
      connectTimeoutSeconds: auditSettings.connect_timeout_seconds,
      statementTimeoutMs: auditSettings.statement_timeout_ms,
      lockTimeoutMs: auditSettings.lock_timeout_ms,
    });
    return { db: connection.db, end: (options: { timeout: number }) => connection.sql.end(options) };
  };
  const audit = createAuditRecorder(openAudit, { text, log: stderrLine, writeTimeoutMs: auditSettings.write_timeout_ms });
  const context = defaultContext(database.db, settings, { text, writeDb: writerDb, trackingWriteDb: trackingDb, actionDb: actionConnection?.db, audit });
  const version = packageVersion();
  const handle = serveStdio(() => buildServer(context, { version }), {
    onerror: (error) => stderrLine(`[mcp] transport error: ${error.name}`),
  });
  stderrLine(text("serve.ready", { tools: tools.join(", ") }));

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled([handle.close()]).then(() => Promise.allSettled([audit.close()])).then(() => Promise.allSettled([database.close(), closeDb(), ...(actionConnection ? [actionConnection.sql.end({ timeout: 5 })] : []), ...(writable ? [writable.sql.end({ timeout: 5 })] : [])])).then(() => {
      stderrLine(text("serve.stopped"));
      process.exit(code);
    });
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  process.stdin.on("end", () => stop(0));
  process.stdin.on("close", () => stop(0));
  process.on("uncaughtException", (error) => {
    stderrLine(text("serve.failed", { category: error instanceof Error ? error.name : typeof error }));
    stop(1);
  });
}

void main().catch((error: unknown) => {
  stderrLine(mcpTranslator()("serve.failed", { category: error instanceof Error ? error.name : typeof error }));
  process.exit(1);
});
