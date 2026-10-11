/**
 * The read-only MCP server over stdio (docs/mcp.md): an MCP client you configure (Claude Desktop, Claude Code, ...) starts this as a
 * child process and talks to it on stdin / stdout. No port is opened; nothing is written to the database.
 *
 *   pnpm --silent mcp:serve
 *
 * Off by default: with mcp.yaml `enabled: false` (or every tool switched off, or an unreadable mcp.yaml) it says why on stderr and
 * exits with 1, which the client shows in its log. stdout carries protocol messages only; every other line goes to stderr.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createReadOnlyDb } from "../src/lib/db/read-only-client";
import { stderrLine } from "../src/lib/mcp/call-log";
import { buildServer, defaultContext } from "../src/lib/mcp/server";
import { configProblem, enabledTools, readMcpSettings } from "../src/lib/mcp/settings";
import { mcpTranslator } from "../src/lib/mcp/text";

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

function main(): void {
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
  const tools = enabledTools(settings);
  if (tools.length === 0) {
    stderrLine(text("serve.noTools"));
    process.exit(1);
  }

  const database = createReadOnlyDb();
  const context = defaultContext(database.db, settings, { text });
  const version = packageVersion();
  const handle = serveStdio(() => buildServer(context, { version }), {
    onerror: (error) => stderrLine(`[mcp] transport error: ${error.name}`),
  });
  stderrLine(text("serve.ready", { tools: tools.join(", ") }));

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled([handle.close(), database.close()]).then(() => {
      stderrLine(text("serve.stopped"));
      process.exit(code);
    });
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  // the client closed its end of the pipe: the session is over
  process.stdin.on("end", () => stop(0));
  process.stdin.on("close", () => stop(0));
  process.on("uncaughtException", (error) => {
    stderrLine(text("serve.failed", { category: error instanceof Error ? error.name : typeof error }));
    stop(1);
  });
}

main();
