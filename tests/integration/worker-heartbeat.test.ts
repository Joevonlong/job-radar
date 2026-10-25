import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import type { EvidenceConnection } from "@/lib/db/repos/ai-worker-evidence";
import { instanceApplicationName } from "@/lib/db/instance-lock";
import { HEARTBEAT_PROCESS, writeHeartbeat } from "@/lib/db/repos/heartbeats";
import { setRuntimeState } from "@/lib/db/repos/runtime-state";

import { createIsolatedDb, type IsolatedDb } from "../helpers/isolated-db";

/**
 * scripts/ops/worker-heartbeat.ts (and ai_worker_wait_ready, which calls it) against a real Postgres: a database of its
 * own, owned by a non-superuser role, so the instance lock and pg_stat_activity behave as for the worker's role. The
 * lock holder is a separate process (tests/fixtures/ops/hold-instance-lock.ts). Children keep the test environment
 * (VITEST included), so the test database guard applies in them too.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const loader = path.join(repo, "node_modules/tsx/dist/loader.mjs");
const script = path.join(repo, "scripts/ops/worker-heartbeat.ts");
const holderScript = path.join(repo, "tests/fixtures/ops/hold-instance-lock.ts");
const aiWorkerLib = path.join(repo, "scripts/ops/lib/ai-worker.sh");

let iso: IsolatedDb;
let otherRoleUrl = "";
let conn: EvidenceConnection;
let tmp = "";
const holders: ChildProcess[] = [];

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "evidence");
  otherRoleUrl = await iso.addRole("x");
  conn = createConnection(iso.url, { max: 1 });
}, 60_000);

afterAll(async () => {
  await conn?.sql.end({ timeout: 2 });
  await iso?.drop();
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-heartbeat-"));
  await conn.sql`truncate table runner_heartbeats`;
  await conn.sql`delete from runtime_state where key = 'shipped_config:ai-worker'`;
});

afterEach(async () => {
  for (const child of holders.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
  }
  if (tmp && path.basename(tmp).startsWith("worker-heartbeat-")) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

interface Probe {
  status: number | null;
  json: Record<string, unknown>;
  stdout: string;
}
function probe(args: string[], url: string, cwd = repo): Probe {
  const r = spawnSync(process.execPath, ["--import", loader, script, ...args], {
    cwd,
    // tsx finds the path aliases through the repo's tsconfig, also from another working directory
    env: { ...process.env, DATABASE_URL: url, TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json") },
    encoding: "utf8",
    timeout: 60_000,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: r.status, json, stdout: r.stdout };
}
const now = (url = iso.url): string => {
  const r = probe(["--now"], url);
  expect(r.status).toBe(0);
  return String(r.json.now);
};

async function startHolder(url: string): Promise<{ pid: number; vitest: boolean }> {
  const record = path.join(tmp, `holder-${holders.length}.json`);
  const child = spawn(process.execPath, ["--import", loader, holderScript], {
    cwd: repo,
    env: { ...process.env, DATABASE_URL: url, RECORD_FILE: record },
    stdio: ["ignore", "ignore", "pipe"],
  });
  holders.push(child);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const until = Date.now() + 30_000;
  while (!fs.existsSync(record) || fs.readFileSync(record, "utf8") === "") {
    if (child.exitCode !== null || Date.now() > until) throw new Error(`lock holder did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const rec = JSON.parse(fs.readFileSync(record, "utf8")) as { pid: number; acquired: boolean; vitest: boolean };
  expect(rec.acquired).toBe(true);
  return { pid: rec.pid, vitest: rec.vitest };
}
const heartbeat = (): Promise<unknown> => writeHeartbeat(conn.db, HEARTBEAT_PROCESS.aiWorker);
const host = os.hostname();

describe("worker-heartbeat.ts --now", () => {
  it("prints the database clock in UTC with microseconds", () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});

describe("worker-heartbeat.ts --evidence", () => {
  it("nobody holds the lock: not yet (2)", () => {
    const r = probe(["--evidence", "--pid", "123", "--host", host, "--since", now()], iso.url);
    expect(r.status).toBe(2);
    expect(r.json).toEqual({ status: "not_yet", reason: "no-holder" });
  });

  it("the holder of the same role: found (0) only with an ai-worker heartbeat at or after since and the lock connection's start", async () => {
    const since = now();
    await heartbeat(); // before the holder's connection started: does not count
    const holder = await startHolder(iso.url);
    expect(holder.vitest).toBe(true);
    const args = ["--evidence", "--pid", String(holder.pid), "--host", host, "--since", since];

    expect(probe(args, iso.url)).toMatchObject({ status: 2, json: { status: "not_yet", reason: "no-heartbeat" } });
    await writeHeartbeat(conn.db, HEARTBEAT_PROCESS.runner); // another process's heartbeat does not count either
    expect(probe(args, iso.url).status).toBe(2);
    await heartbeat();
    expect(probe(args, iso.url)).toMatchObject({ status: 0, json: { status: "found", reason: "lock-and-heartbeat" } });
    // a since after that heartbeat: not yet
    expect(probe(["--evidence", "--pid", String(holder.pid), "--host", host, "--since", now()], iso.url).status).toBe(2);
  });

  it("another pid or another host holds the lock: not yet (2), other-holder", async () => {
    const holder = await startHolder(iso.url);
    await heartbeat();
    const since = "2000-01-01T00:00:00Z";
    const otherPid = probe(["--evidence", "--pid", String(holder.pid + 1), "--host", host, "--since", since], iso.url);
    expect(otherPid).toMatchObject({ status: 2, json: { status: "not_yet", reason: "other-holder", holder: instanceApplicationName("ai-worker", holder.pid, host) } });
    const otherHost = probe(["--evidence", "--pid", String(holder.pid), "--host", "elsewhere.invalid", "--since", since], iso.url);
    expect(otherHost.json).toMatchObject({ reason: "other-holder" });
  });

  it("a holder of another role: cannot tell (1), because its session's details are not visible to the worker's role", async () => {
    const holder = await startHolder(otherRoleUrl);
    await heartbeat();
    const r = probe(["--evidence", "--pid", String(holder.pid), "--host", host, "--since", "2000-01-01T00:00:00Z"], iso.url);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({ status: "unknown", reason: "holder-not-visible" });
  });

  it("no .env is read: a .env in the working directory changes nothing, and an empty DATABASE_URL exits 1", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "DATABASE_URL=postgres://nobody:x@127.0.0.1:1/jobradar_test_nowhere\n");
    const r = probe(["--evidence", "--pid", "123", "--host", host, "--since", "2000-01-01T00:00:00Z"], iso.url, tmp);
    expect(r).toMatchObject({ status: 2, json: { reason: "no-holder" } });
    const empty = probe(["--now"], "", tmp);
    expect(empty.status).toBe(1);
    expect(empty.json).toMatchObject({ status: "unknown", reason: "error" });
    expect(String(empty.json.detail)).toContain("DATABASE_URL is empty");
  });

  it.each([
    [["--latest"]],
    [["--now", "--evidence"]],
    [["--now", "--pid", "1"]],
    [["--evidence", "--pid", "0", "--host", "h", "--since", "2000-01-01T00:00:00Z"]],
    [["--evidence", "--pid", "1", "--host", "h", "--since", "yesterday"]],
    [[]],
  ])("bad arguments %j: cannot tell (1), one JSON line, the URL never printed", (args) => {
    const r = probe(args, iso.url);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({ status: "unknown", reason: "error" });
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).not.toContain(new URL(iso.url).password);
  });

  it("the test database guard holds in the child: a non-test database name is refused under Vitest", () => {
    const u = new URL(iso.url);
    u.pathname = "/jobradar";
    const r = probe(["--now"], u.toString());
    expect(r.status).toBe(1);
    expect(String(r.json.detail)).toContain("Refusing to connect");
    expect(r.stdout).not.toContain(u.password);
  });

  it("the script holds no SQL (queries live in src/lib/db/repos)", () => {
    const text = fs.readFileSync(script, "utf8");
    expect(text).not.toMatch(/\bsql`|\bselect\s|\binsert\s|\bfrom\s+pg_/i);
    expect(text).not.toContain("--latest");
  });
});

describe("worker-heartbeat.ts --receipt", () => {
  it.each(["own report", "other pid", "old report", "other host", "other holder"])("requires the holder's own report after its lock: %s", async (scenario) => {
    const since = now();
    const holder = await startHolder(iso.url);
    // A heartbeat has no writer PID: the report must still belong to the holder.
    await heartbeat();
    await setRuntimeState(conn.db, "shipped_config:ai-worker", {
      pid: scenario === "other pid" ? holder.pid + 1 : holder.pid,
      instance: scenario === "other host" ? "elsewhere.invalid" : host,
    });
    if (scenario === "old report") {
      // One microsecond before backend_start also catches accidental JS Date rounding.
      await conn.sql`update runtime_state set updated_at = (
        select backend_start - interval '1 microsecond' from pg_stat_activity
        where application_name = ${instanceApplicationName("ai-worker", holder.pid, host)}
      ) where key = 'shipped_config:ai-worker'`;
    }
    const pid = scenario === "other holder" ? holder.pid + 1 : holder.pid;
    const r = probe(["--receipt", "--pid", String(pid), "--host", host, "--since", since], iso.url);
    expect(r.status).toBe(scenario === "own report" ? 0 : 2);
    expect(r.json).toMatchObject(scenario === "own report"
      ? { status: "found", reason: "lock-heartbeat-report" }
      : { status: "not_yet", reason: scenario === "other holder" ? "other-holder" : "no-report" });
  });
});

describe("the application_name of the instance lock (an interface: the evidence compares it exactly)", () => {
  it("is `job-radar <name> pid=<pid> host=<host>`, cut to 63 characters", () => {
    expect(instanceApplicationName("ai-worker", 4242, "mac.local")).toBe("job-radar ai-worker pid=4242 host=mac.local");
    const long = instanceApplicationName("ai-worker", 4242, "h".repeat(80));
    expect(long).toHaveLength(63);
    expect(long.startsWith("job-radar ai-worker pid=4242 host=hhh")).toBe(true);
  });

  it("is what the holder's session shows in pg_stat_activity", async () => {
    const holder = await startHolder(iso.url);
    const rows = await conn.sql<{ application_name: string }[]>`
      select application_name from pg_stat_activity where datname = current_database() and application_name like 'job-radar ai-worker %'`;
    expect(rows.map((r) => r.application_name)).toEqual([instanceApplicationName("ai-worker", holder.pid, host)]);
  });
});

describe("ai_worker_wait_ready (stub launchctl reports the holder's pid)", () => {
  const LABEL = "test.invalid.evidence";
  // the timeout bounds the evidence probes too (node and tsx start inside it): generous where success is expected
  function waitReady(url: string, oldPid: string, since: string, pid: number, timeout = 20): { status: number | null; stdout: string; stderr: string } {
    const main = path.join(tmp, "main");
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(path.join(main, "config"), { recursive: true });
    fs.writeFileSync(path.join(main, "config/schedule.yaml"), `doctor:\n  ai_worker_launchd_label: ${LABEL}\n`);
    // the installed definition (only its existence is read): the label polled is the one in force
    fs.mkdirSync(path.join(tmp, "Library/LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(tmp, `Library/LaunchAgents/${LABEL}.plist`), "<plist/>\n");
    fs.mkdirSync(bin, { recursive: true });
    // only the made-up label is answered; any other call fails
    fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/bash\n[[ "$1" == print && "$2" == */${LABEL} ]] && { echo "pid = ${pid}"; exit 0; }\nexit 113\n`, { mode: 0o755 });
    const r = spawnSync("/bin/bash", ["-c", `source "${aiWorkerLib}"; ai_worker_wait_ready "$1" "$2" "$3" "$4"`, "_", main, oldPid, since, String(timeout)], {
      env: {
        ...process.env,
        PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: tmp,
        JOB_RADAR_SERVICE_MANAGER: "launchd",
        DATABASE_URL: url,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("prints the new pid and returns 0 once there is evidence for it", async () => {
    const since = now();
    const holder = await startHolder(iso.url);
    await heartbeat();
    const r = waitReady(iso.url, "1", since, holder.pid);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(holder.pid));
  }, 60_000);

  it("times out (1) when the lock holder is another role (no evidence can be had)", async () => {
    const since = now();
    const holder = await startHolder(otherRoleUrl);
    await heartbeat();
    const r = waitReady(iso.url, "1", since, holder.pid, 3);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  }, 60_000);
});
