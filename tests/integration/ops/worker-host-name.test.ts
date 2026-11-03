import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { instanceApplicationName } from "@/lib/db/instance-lock";

import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";

/**
 * Host names reach Postgres through `application_name`, which keeps 63 bytes and turns what is not printable ASCII into
 * question marks. `instanceApplicationName` has to survive that unchanged: the release tooling compares the holder's name
 * with one it builds itself.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const SCRIPT = path.join(REPO, "scripts/ops/worker-heartbeat.ts");
const HOLDER = path.join(REPO, "tests/fixtures/ops/hold-instance-lock.ts");
const NON_ASCII_HOST = "主机-münchen";
const LONG_HOST = `${"long-host-".repeat(8)}example`;

let iso: IsolatedDb;
let tmp = "";
const holders: ChildProcess[] = [];

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "hostname");
}, 60_000);

afterAll(async () => {
  await iso?.drop();
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-host-name-"));
});

afterEach(async () => {
  for (const child of holders.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function startHolder(host: string): Promise<number> {
  const record = path.join(tmp, "holder.json");
  const child = spawn(process.execPath, ["--import", LOADER, HOLDER], { cwd: REPO, env: { ...process.env, DATABASE_URL: iso.url, RECORD_FILE: record, TEST_WORKER_HOST: host }, stdio: "ignore" });
  holders.push(child);
  const until = Date.now() + 30_000;
  while (!fs.existsSync(record) || fs.readFileSync(record, "utf8") === "") {
    if (child.exitCode !== null || Date.now() > until) throw new Error("the lock holder did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const parsed = JSON.parse(fs.readFileSync(record, "utf8")) as { pid: number; host: string; acquired: boolean };
  expect(parsed).toMatchObject({ host, acquired: true });
  return parsed.pid;
}

function holderStatus(pid: number, host: string): { status: number | null; json: Record<string, unknown> } {
  const r = spawnSync(process.execPath, ["--import", LOADER, SCRIPT, "--holder", "--pid", String(pid), "--host", host], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: iso.url, TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, json: JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown> };
}

describe("a host name on its way through application_name", () => {
  it.each([["non-ASCII", NON_ASCII_HOST], ["long ASCII", LONG_HOST]])("%s: the name reads back byte-identical", async (_kind, host) => {
    const application = instanceApplicationName("x", 123, host);
    const sql = postgres(iso.url, { max: 1, connection: { application_name: application }, onnotice: () => {} });
    try {
      const rows = await sql<{ application_name: string }[]>`select application_name from pg_stat_activity where pid = pg_backend_pid()`;
      expect(Buffer.from(rows[0]?.application_name ?? "").equals(Buffer.from(application))).toBe(true);
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  it("the long host really is over Postgres's limit, so that case tests the truncation", () => {
    expect(Buffer.byteLength(`job-radar x pid=123 host=${LONG_HOST}`)).toBeGreaterThan(63);
    expect(Buffer.byteLength(instanceApplicationName("x", 123, LONG_HOST))).toBeLessThanOrEqual(63);
  });

  it.each([["non-ASCII", NON_ASCII_HOST], ["long ASCII", LONG_HOST]])("--holder says expected for a holder on a %s host, and other for another host or pid", async (_kind, host) => {
    const pid = await startHolder(host);
    expect(holderStatus(pid, host)).toMatchObject({ status: 0, json: { status: "expected" } });
    expect(holderStatus(pid + 1, host)).toMatchObject({ status: 0, json: { status: "other" } });
    expect(holderStatus(pid, "elsewhere.invalid")).toMatchObject({ status: 0, json: { status: "other" } });
  });

  it("two non-ASCII hosts of the same shape are told apart: the name carries their bytes", async () => {
    const pid = await startHolder(NON_ASCII_HOST);
    expect(instanceApplicationName("ai-worker", pid, "服务-münchen")).not.toBe(instanceApplicationName("ai-worker", pid, NON_ASCII_HOST));
    expect(holderStatus(pid, "服务-münchen")).toMatchObject({ status: 0, json: { status: "other" } });
  });
});
