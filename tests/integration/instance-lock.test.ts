import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";

import { acquireInstanceLock, AI_WORKER_LOCK_KEY, type InstanceLock } from "@/lib/db/instance-lock";
import { withCycleLock } from "@/lib/cycle/lock";
import { aiWorkerRequestKinds } from "@/lib/control";
import { claimNextControlRequest, closeDb, getControlRequest, getDb, insertControlRequest } from "@/lib/db";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

import { FIXTURE_DEFAULTS_DIR } from "../config/helpers";

const url = inject("testDatabaseUrl");
const held: InstanceLock[] = [];

async function take(name = "ai-worker", key?: readonly [number, number]) {
  const result = await acquireInstanceLock(url, { name, ...(key ? { key } : {}) });
  if (result.acquired) held.push(result.lock);
  return result;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
});

afterAll(async () => {
  await closeDb();
});

const APP_ROOT = path.resolve(import.meta.dirname, "../..");

/** Run the real ai-worker entry point (`pnpm ai-worker --once`) against the test database; no AI CLI is ever reached. */
function runWorkerOnce(): { status: number | null; output: string } {
  const result = spawnSync(path.join(APP_ROOT, "node_modules/.bin/tsx"), ["src/ai-worker/index.ts", "--once"], {
    cwd: APP_ROOT,
    env: {
      // only node itself on PATH and an empty HOME: even a broken lock could never reach a real claude / codex login
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: os.tmpdir(),
      DATABASE_URL: url,
      JOB_RADAR_DEFAULTS_DIR: FIXTURE_DEFAULTS_DIR,
      JOB_RADAR_CONFIG_DIR: path.join(APP_ROOT, "tests/fixtures/config/no-such-user-dir"),
      JOB_RADAR_PROFILE_DIR: path.join(APP_ROOT, "tests/fixtures/config/no-such-profile-dir"),
      JOB_RADAR_CONFIG_POLL_MS: "0",
      NODE_ENV: "test",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("single-instance lock (ai-worker)", () => {
  it("acquires by URL without application path aliases, as a standalone worker does", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instance-lock-loader-"));
    const tsconfig = path.join(tmp, "tsconfig.json");
    fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { module: "esnext", target: "es2022" } }));
    try {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(path.join(APP_ROOT, "node_modules/tsx/dist/loader.mjs")).href,
        "--input-type=module", "--eval", `
          import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(path.join(APP_ROOT, "src/lib/db/instance-lock.ts")).href)};
          const result = await acquireInstanceLock(process.env.DATABASE_URL, { name: "ai-worker" });
          if (!result.acquired) throw new Error("lock not acquired");
          try {
            console.log(await result.lock.check());
          } finally {
            await result.lock.release();
          }
        `,
      ], {
        cwd: tmp,
        env: { NODE_ENV: "test", DATABASE_URL: url, VITEST: "true", TSX_TSCONFIG_PATH: tsconfig },
        encoding: "utf8",
        timeout: 15_000,
        killSignal: "SIGKILL",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("held");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the first process gets it, a second one is refused and told who holds it", async () => {
    const first = await take();
    expect(first.acquired).toBe(true);
    const second = await take();
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.holder?.application).toMatch(new RegExp(`^job-radar ai-worker pid=${process.pid} host=`));
    expect(second.holder?.since).toBeInstanceOf(Date);
  });

  it("is free again once the holder releases it (or its connection ends)", async () => {
    const first = await take();
    if (!first.acquired) throw new Error("not acquired");
    await first.lock.release();
    expect(await first.lock.check()).toBe("lost");
    const again = await take();
    expect(again.acquired).toBe(true);
  });

  it("check: held while ours; reacquired after the connection was killed; lost when another process took it meanwhile", async () => {
    const first = await take();
    if (!first.acquired) throw new Error("not acquired");
    expect(await first.lock.check()).toBe("held");

    const admin = postgres(url, { max: 1, onnotice: () => {} });
    const [k1, k2] = AI_WORKER_LOCK_KEY;
    const holderPid = async (): Promise<number | null> => {
      const rows = await admin<{ pid: number }[]>`select pid from pg_locks where locktype = 'advisory' and granted and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2`;
      return rows[0]?.pid ?? null;
    };
    try {
      // a database restart: the backend dies, postgres.js reconnects on the next query, the lock is taken again
      await admin`select pg_terminate_backend(${await holderPid()})`;
      expect(await first.lock.check()).toBe("reacquired");
      expect(await first.lock.check()).toBe("held");

      // killed again, and this time another worker grabs the lock before we look
      await admin`select pg_terminate_backend(${await holderPid()})`;
      const other = await take("ai-worker-2");
      expect(other.acquired).toBe(true);
      expect(await first.lock.check()).toBe("lost");
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it("uses its own key: the cycle lock and the ai-worker lock never block each other", async () => {
    const worker = await take();
    expect(worker.acquired).toBe(true);
    const connection = createConnection(url, { max: 2 });
    try {
      const cycle = await withCycleLock(connection.db, "try", async () => "ran");
      expect(cycle).toEqual({ acquired: true, value: "ran" });
    } finally {
      await connection.sql.end({ timeout: 5 });
    }
    expect([...AI_WORKER_LOCK_KEY]).not.toEqual([0x4a52, 0x0001]);
  });
});

describe("ai-worker process", () => {
  it("--once exits with code 3 while another worker holds the lock, and leaves that worker's running request alone", async () => {
    const lock = await take();
    expect(lock.acquired).toBe(true);
    await insertControlRequest(getDb(), { kind: "translate_job", payload: { jobId: 1 } });
    const running = await claimNextControlRequest(getDb(), aiWorkerRequestKinds("host"));
    expect(running?.status).toBe("running");

    const { status, output } = runWorkerOnce();
    expect(status).toBe(3);
    expect(output).toMatch(/another ai-worker is running against this database \(job-radar ai-worker pid=\d+ host=/);
    expect(output).not.toMatch(/queued .* interrupted request/);
    expect((await getControlRequest(getDb(), running!.id))?.status).toBe("running");
  }, 90_000);
});
