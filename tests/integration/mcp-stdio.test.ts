/**
 * The real `pnpm mcp:serve` entry point as a child process, spoken to with raw JSON-RPC on stdin / stdout the way an MCP client
 * does: stdout carries protocol messages only, the log goes to stderr, and a switched-off server says why and exits.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { seedDatabase } from "@/lib/db/seed";
import { mcpTranslator } from "@/lib/mcp/text";

import { FIXTURE_DEFAULTS_DIR } from "../config/helpers";

const url = inject("testDatabaseUrl");
const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(APP_ROOT, "node_modules/.bin/tsx");

let userDir: string;

function serverEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: os.tmpdir(),
    DATABASE_URL: url,
    DB_CONNECT_TIMEOUT_SECONDS: "30",
    JOB_RADAR_DEFAULTS_DIR: FIXTURE_DEFAULTS_DIR,
    JOB_RADAR_CONFIG_DIR: configDir,
    JOB_RADAR_PROFILE_DIR: path.join(APP_ROOT, "tests/fixtures/config/no-such-profile-dir"),
    JOB_RADAR_CONFIG_POLL_MS: "0",
    NODE_ENV: "test",
  };
}

interface Session {
  stdout: string[];
  stderr: string;
  code: number | null;
}

/** Start the server, send each message as one line, wait for the replies to the requests, close stdin and wait for the exit. */
function converse(messages: Array<Record<string, unknown>>, env: NodeJS.ProcessEnv): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["scripts/mcp-serve.ts"], { cwd: APP_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    const session: Session = { stdout: [], stderr: "", code: null };
    const waitingFor = new Set(messages.filter((m) => "id" in m).map((m) => m.id));
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no answer in time; stderr: ${session.stderr}`));
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        session.stdout.push(line);
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          waitingFor.delete(parsed.id);
        } catch {
          // kept: the test fails on a line that is not JSON
        }
        newline = buffer.indexOf("\n");
      }
      if (waitingFor.size === 0) child.stdin.end();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (buffer.length > 0) session.stdout.push(buffer);
      session.code = code;
      resolve(session);
    });
    // a client writes right away; the pipe holds the lines until the server reads them
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    if (waitingFor.size === 0) child.stdin.end();
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-mcp-stdio-"));
});

// the shared setup empties the tables before every test
beforeEach(async () => {
  await seedDatabase(getDb(), { now: new Date(), timezone: "Europe/Berlin" });
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe("mcp:serve over stdio", () => {
  it("answers initialize, tools/list and a tool call; stdout is JSON-RPC only, the log is on stderr", async () => {
    const configDir = path.join(userDir, "on");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "mcp.yaml"), "enabled: true\n");
    const session = await converse(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_jobs", arguments: { limit: 3 } } },
      ],
      serverEnv(configDir),
    );
    expect(session.stdout.length).toBeGreaterThanOrEqual(3);
    const replies = session.stdout.map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result?: Record<string, unknown> });
    for (const reply of replies) expect(reply.jsonrpc).toBe("2.0");
    const byId = new Map(replies.map((r) => [r.id, r.result]));
    expect((byId.get(1)?.serverInfo as { name: string }).name).toBe("job-radar");
    expect((byId.get(2)?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["search_jobs", "get_job", "list_applications"]);
    const search = byId.get(3) as { isError?: boolean; structuredContent: { returned: number } };
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent.returned).toBe(3);
    // same config defaults as this process, so the same language
    expect(session.stderr).toContain(mcpTranslator()("serve.ready", { tools: "search_jobs, get_job, list_applications" }));
    expect(session.stderr).toMatch(/\[mcp\] search_jobs ok items=3 ms=\d+/);
    expect(session.code).toBe(0);
  }, 60_000);

  it("supports description scope and exact country over stdio without adding output fields", async () => {
    const db = getDb();
    const seeded = await db.execute<{ id: number; title: string; status: string }>(sql`select id, title, status from jobs where title in ('Forward Deployed Engineer', 'Machine Learning Engineer, Perception')`);
    const forward = seeded.find((job) => job.title === "Forward Deployed Engineer" && job.status === "active");
    const perception = seeded.find((job) => job.title === "Machine Learning Engineer, Perception" && job.status === "active");
    // The salary lookup seed adds a closed copy with the same title.
    const excluded = seeded.find((job) => job.title === "Forward Deployed Engineer" && job.status === "closed");
    if (!forward || !perception || !excluded) throw new Error("expected two active search fixtures and the closed salary lookup origin");
    await db.execute(sql`update jobs set description = 'Deutschlandticket', locations_json = '[{"city":"Berlin","countryCode":"DE","label":"Berlin"}]'::jsonb where id in (${forward.id}, ${perception.id}, ${excluded.id})`);
    const expectedIds = [Number(forward.id), Number(perception.id)].sort((a, b) => a - b);
    const configDir = path.join(userDir, "search-scope");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "mcp.yaml"), "enabled: true\n");
    const session = await converse([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "search-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_jobs", arguments: { query: "Deutschlandticket" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_jobs", arguments: { query: "Deutschlandticket", search_in: "all", country: ["de"] } } },
    ], serverEnv(configDir));
    const replies = session.stdout.map((line) => JSON.parse(line) as { id: number; result?: { isError?: boolean; structuredContent?: { jobs: { id: number }[]; total: number } } });
    const summary = replies.find((reply) => reply.id === 2)?.result;
    const all = replies.find((reply) => reply.id === 3)?.result;
    expect(summary?.isError).not.toBe(true);
    expect(summary?.structuredContent?.jobs).toEqual([]);
    expect(all?.isError).not.toBe(true);
    expect(all?.structuredContent?.total).toBe(2);
    const actualIds = all?.structuredContent?.jobs.map((job) => job.id).sort((a, b) => a - b);
    expect(actualIds).toEqual(expectedIds);
    expect(actualIds).not.toContain(Number(excluded.id));
    expect(all?.structuredContent?.jobs.every((job) => !("description" in job))).toBe(true);
    expect(session.code).toBe(0);
  }, 60_000);

  it("switched off (the default): says so on stderr, writes nothing to stdout and exits with 1", () => {
    const configDir = path.join(userDir, "off");
    fs.mkdirSync(configDir);
    const result = spawnSync(TSX, ["scripts/mcp-serve.ts"], { cwd: APP_ROOT, env: serverEnv(configDir), input: "", encoding: "utf8", timeout: 45_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(mcpTranslator()("serve.disabled"));
  }, 60_000);
});
