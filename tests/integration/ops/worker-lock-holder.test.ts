import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";

/**
 * `worker-heartbeat.ts --lock-holder`, the question the deploy's write step asks when it was told to leave the worker
 * alone: 0 nobody holds the instance lock, 2 somebody does, 1 cannot tell. The holder is a separate process.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const SCRIPT = path.join(REPO, "scripts/ops/worker-heartbeat.ts");
const HOLDER = path.join(REPO, "tests/fixtures/ops/hold-instance-lock.ts");

let iso: IsolatedDb;
let otherRoleUrl = "";
let tmp = "";
const holders: ChildProcess[] = [];

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "lockholder");
  otherRoleUrl = await iso.addRole("other");
}, 60_000);

afterAll(async () => {
  await iso?.drop();
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-lock-holder-"));
});

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

afterEach(async () => {
  for (const child of holders.splice(0)) await stopHolder(child);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function lockHolder(url: string): { status: number | null; json: Record<string, unknown>; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", LOADER, SCRIPT, "--lock-holder"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: url, TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, json: JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>, stdout: r.stdout, stderr: r.stderr };
}

async function startHolder(url: string): Promise<{ child: ChildProcess; pid: number }> {
  const record = path.join(tmp, "holder.json");
  fs.rmSync(record, { force: true });
  const child = spawn(process.execPath, ["--import", LOADER, HOLDER], { cwd: REPO, env: { ...process.env, DATABASE_URL: url, RECORD_FILE: record }, stdio: "ignore" });
  holders.push(child);
  const until = Date.now() + 30_000;
  while (!fs.existsSync(record) || fs.readFileSync(record, "utf8") === "") {
    if (child.exitCode !== null || Date.now() > until) throw new Error("the lock holder did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const parsed = JSON.parse(fs.readFileSync(record, "utf8")) as { pid: number; acquired: boolean };
  expect(parsed.acquired).toBe(true);
  return { child, pid: parsed.pid };
}

describe("worker-heartbeat.ts --lock-holder", () => {
  it("idle: exit 0, status none, and asking does not take the lock", async () => {
    expect(lockHolder(iso.url)).toMatchObject({ status: 0, json: { status: "none" } });
    const { pid } = await startHolder(iso.url); // would fail to acquire if the probe had kept it
    expect(pid).toBeGreaterThan(0);
  });

  it("held: exit 2 and the holder's name; free again once the holder is gone", async () => {
    const { child, pid } = await startHolder(iso.url);
    const held = lockHolder(iso.url);
    expect(held.status).toBe(2);
    expect(held.json.status).toBe("held");
    expect(held.json.application).toContain(`job-radar ai-worker pid=${pid} `);
    await stopHolder(child);
    expect(lockHolder(iso.url)).toMatchObject({ status: 0, json: { status: "none" } });
  });

  it("a holder under another role still counts as held", async () => {
    const { pid } = await startHolder(otherRoleUrl);
    const held = lockHolder(iso.url);
    expect(held).toMatchObject({ status: 2, json: { status: "held" } });
    expect(held.json.application).toContain(`pid=${pid} `);
  });

  it("unreachable: exit 1, and the URL is not printed", () => {
    const secret = "not-a-password-but-do-not-print-it";
    const r = lockHolder(`postgres://nobody:${secret}@127.0.0.1:1/jobradar_test_absent`);
    expect(r.status).toBe(1);
    expect(r.json.status).toBe("unknown");
    expect(`${r.stdout}${r.stderr}`).not.toContain(secret);
  });

  it("no database URL: exit 1, not an answer", () => {
    expect(lockHolder("")).toMatchObject({ status: 1, json: { status: "unknown" } });
  });
});
