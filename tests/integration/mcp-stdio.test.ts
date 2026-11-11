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
import { z } from "zod";

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
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
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

const rpcReplySchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
});
type RpcReply = z.infer<typeof rpcReplySchema>;

/** A running stdio child with bounded, id-matched requests and bounded shutdown. */
function openSession(env: NodeJS.ProcessEnv) {
  const child = spawn(TSX, ["scripts/mcp-serve.ts"], { cwd: APP_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (reply: RpcReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;
  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      closed = true;
      fail(new Error(`child closed with ${code}; stderr: ${stderr}`));
      resolve(code);
    });
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const reply = rpcReplySchema.parse(JSON.parse(line));
        const request = reply.id === undefined ? undefined : pending.get(reply.id);
        if (request && reply.id !== undefined) {
          clearTimeout(request.timer);
          pending.delete(reply.id);
          request.resolve(reply);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("invalid JSON-RPC reply"));
      }
      newline = buffer.indexOf("\n");
    }
  });

  const waitForExit = () => new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit; stderr: ${stderr}`));
    }, 10_000);
    void exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return {
    request: (method: string, params: Record<string, unknown> = {}) => new Promise<RpcReply>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no reply for ${id}; stderr: ${stderr}`));
      }, 45_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    notify: (method: string) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    finish: () => {
      child.stdin.end();
      return waitForExit();
    },
    close: async () => {
      if (!closed) child.kill("SIGKILL");
      await waitForExit();
    },
  };
}

describe("mcp:serve live settings", () => {
  it("refuses the next call when mcp.yaml changes while connected", async () => {
    const configDir = path.join(userDir, "live-settings");
    fs.mkdirSync(configDir);
    const file = path.join(configDir, "mcp.yaml");
    fs.writeFileSync(file, "enabled: true\n");
    const session = openSession(serverEnv(configDir));
    const text = mcpTranslator();
    try {
      const initialized = await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-settings-test", version: "1.0.0" } });
      expect(initialized.error).toBeUndefined();
      session.notify("notifications/initialized");
      const initial = await session.request("tools/call", { name: "list_applications", arguments: {} });
      expect(initial.error).toBeUndefined();
      expect(initial.result).toBeDefined();
      expect(initial.result?.isError).not.toBe(true);

      fs.writeFileSync(file, "enabled: true\ntools:\n  list_applications: false\n");
      const refused = await session.request("tools/call", { name: "list_applications", arguments: {} });
      expect(refused.result?.isError).toBe(true);
      expect(JSON.stringify(refused.result)).toContain(text("errors.notPermitted", { permission: "tracking:read" }));
      const search = await session.request("tools/call", { name: "search_jobs", arguments: {} });
      expect(search.error).toBeUndefined();
      expect(search.result).toBeDefined();
      expect(search.result?.isError).not.toBe(true);

      fs.writeFileSync(file, "enabled: [\n");
      const broken = await session.request("tools/call", { name: "search_jobs", arguments: {} });
      expect(broken.result?.isError).toBe(true);
      expect(JSON.stringify(broken.result)).toContain(text("errors.settingsUnreadable", { problem: "yaml" }));

      fs.writeFileSync(file, "enabled: false\n");
      const disabled = await session.request("tools/call", { name: "search_jobs", arguments: {} });
      expect(disabled.result?.isError).toBe(true);
      expect(JSON.stringify(disabled.result)).toContain(text("errors.serverOff"));
      expect(await session.finish()).toBe(0);
    } finally {
      await session.close();
    }
  }, 90_000);
});
