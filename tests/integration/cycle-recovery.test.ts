import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { ChannelRegistry } from "@/lib/channels/registry";
import { findCycleLockHolder, withCycleLock } from "@/lib/cycle/lock";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, countRunningCycles, createConnection, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { databaseTestSupport } from "@/lib/db/test-support";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const root = path.resolve(import.meta.dirname, "../..");
const data = () => databaseTestSupport(getDb());
let temp: TempConfig;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(() => { temp = makeTempConfig(); });
afterEach(() => { resetCycleSteps(); temp.cleanup(); });
afterAll(() => closeDb());

function cli(script: string, imports: string[] = [], args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", ...imports.flatMap((file) => ["--import", pathToFileURL(file).href]), script, ...args], {
    cwd: root,
    env: {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: temp.root,
      NODE_ENV: "test",
      VITEST: "true",
      DATABASE_URL: url,
      JOB_RADAR_DEFAULTS_DIR: temp.defaultsDir,
      JOB_RADAR_CONFIG_DIR: temp.configDir,
      JOB_RADAR_PROFILE_DIR: temp.profileDir,
      JOB_RADAR_CONFIG_POLL_MS: "0",
      RUNNER_HEARTBEAT_SECONDS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  return { child, output: () => output, finished: finished.finally(() => clearTimeout(timer)) };
}

it("reprocess waits for the cycle lock before it resets any derived facts", async () => {
  const [company] = await data().insertCompany({ name: "Example", nameNorm: "example" });
  await data().insertJob({ companyId: company!.id, title: "Engineer", titleNorm: "engineer", workplace: "remote" });
  let processRun: ReturnType<typeof cli> | undefined;
  try {
    await withCycleLock(getDb(), "try", async () => {
      processRun = cli("scripts/reprocess.ts");
      await vi.waitFor(async () => {
        const waiting = await data().cycleLockWaiters(processRun!.child.pid);
        expect(waiting === 1 || processRun!.output().includes("work mode, German level and agency flag cleared")).toBe(true);
      }, { timeout: 15_000 });
      expect((await data().jobs())[0]?.workplace).toBe("remote");
    });
  } finally {
    if (processRun) expect(await processRun.finished, processRun.output()).toEqual({ code: 0, signal: null });
  }
  expect((await data().jobs())[0]?.workplace).toBe("unknown");
}, 30_000);

it("reprocess stops between filter batches when the lock connection is lost during a write", async () => {
  const pipelineFile = path.join(temp.defaultsDir, "pipeline.yaml");
  const pipeline = parseDocument(fs.readFileSync(pipelineFile, "utf8"));
  pipeline.set("batch_size", 1);
  fs.writeFileSync(pipelineFile, pipeline.toString());
  const [company] = await data().insertCompany({ name: "Example", nameNorm: "example" });
  for (const title of ["Engineer", "Designer"]) {
    await data().insertJob({ companyId: company!.id, title, titleNorm: title.toLowerCase() });
  }
  await data().installFilterWriteGate();
  const blocker = createConnection(url, { max: 1 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = databaseTestSupport(blocker.db).holdFilterWrites(entered, gate);
  let processRun: ReturnType<typeof cli> | undefined;
  try {
    await ready;
    processRun = cli("scripts/reprocess.ts");
    await vi.waitFor(async () => expect(await data().blockedFilterWrites()).toBe(1), { timeout: 15_000 });
    const pid = await findCycleLockHolder(getDb());
    expect(pid).not.toBeNull();
    await data().terminateBackend(pid!);
    // The next heartbeat reconnects and reacquires the lock, which cancels the old body even though it is still in SQL.
    await vi.waitFor(async () => {
      const nextPid = await findCycleLockHolder(getDb());
      expect(nextPid).not.toBeNull();
      expect(nextPid).not.toBe(pid);
    }, { timeout: 5000 });
    release();
    await held;

    expect(await processRun.finished, processRun.output()).toEqual({ code: 1, signal: null });
    expect(await data().scores()).toHaveLength(1);
    expect(processRun.output()).toContain('"evaluated":1');
    expect(processRun.output()).toContain("cycle lock connection lost");
    expect(processRun.output()).not.toContain("amounts revalued:");
  } finally {
    release();
    await held;
    if (processRun) {
      if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
      await processRun.finished;
    }
    await blocker.sql.end({ timeout: 5 });
    await data().removeFilterWriteGate();
  }
}, 30_000);

it.each(["SIGINT", "SIGTERM"] as const)("the real cycle CLI finishes its running row when it receives %s", async (signal) => {
  const bootstrap = path.join(temp.root, "wait-for-abort.mts");
  fs.writeFileSync(bootstrap, `import { registerCycleStep } from ${JSON.stringify(pathToFileURL(path.join(root, "src/lib/cycle/steps.ts")).href)};
registerCycleStep("collect", async (ctx) => {
  console.log("collect waiting for abort");
  await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
});\n`);
  const processRun = cli("scripts/cycle-run.ts", [bootstrap], ["--channel", "fixture"]);
  try {
    await vi.waitFor(() => expect(processRun.output()).toContain("collect waiting for abort"), { timeout: 15_000 });
    processRun.child.kill(signal);
    const exit = await processRun.finished;
    const rows = await data().cycles();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", summaryJson: { aborted: true } });
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
    expect(await countRunningCycles(getDb())).toBe(0);
    expect(exit, processRun.output()).toEqual({ code: 1, signal: null });
  } finally {
    if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
    await processRun.finished;
  }
}, 30_000);

it("the next cycle recovers a row whose final database write failed, without restarting the runner", async () => {
  await data().installFinishFailure();
  // No collectors or AI: exercise just the cycle row's lifecycle and its real finish write.
  for (const name of ["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"] as const) registerCycleStep(name, async () => {});
  const run = () => runCycle("manual", { registry: new ChannelRegistry(), config: config(), logger: quietLogger });
  try {
    await expect(run()).rejects.toThrow();
    const [orphan] = await data().cycles();
    expect(orphan?.status).toBe("running");
    expect((await run()).status).toBe("succeeded");
    const [recovered] = await data().cycle(orphan!.id);
    expect(recovered).toMatchObject({ status: "failed", summaryJson: { orphaned: expect.any(String) } });
    expect(recovered?.finishedAt).toBeInstanceOf(Date);
    expect(await countRunningCycles(getDb())).toBe(0);
  } finally {
    await data().removeFinishFailure();
  }
});

it("losing the lock connection aborts the body and waits for it to settle before returning", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let settled = false;
  let signal: AbortSignal | undefined;
  let pid = 0;
  const pending = withCycleLock(getDb(), "try", async (holder) => {
    pid = holder.pid;
    signal = holder.signal;
    entered();
    await gate;
  }, { checkIntervalMs: 10 }).then(() => { settled = true; }, () => { settled = true; });
  try {
    await ready;
    expect(await findCycleLockHolder(getDb())).toBe(pid);
    await data().terminateBackend(pid);
    await vi.waitFor(() => expect(signal?.aborted || settled).toBe(true), { timeout: 5000 });
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(true);
  } finally {
    release();
    await pending;
  }
  expect(settled).toBe(true);
  expect((await withCycleLock(getDb(), "try", async () => "next")).acquired).toBe(true);
});

it("a cancelled lock wait stops without entering the body, and a one-connection pool still works while locked", async () => {
  const connection = createConnection(url, { max: 1 });
  const abort = new AbortController();
  let entered = false;
  try {
    await withCycleLock(connection.db, "try", async () => {
      // The dedicated lock must not use up the application's only pool connection.
      await databaseTestSupport(connection.db).ping();
      const waiting = withCycleLock(getDb(), "wait", async () => { entered = true; }, { signal: abort.signal });
      try {
        await vi.waitFor(async () => {
          expect(await data().cycleLockWaiters()).toBe(1);
        }, { timeout: 5000 });
      } finally {
        abort.abort();
        expect(await waiting).toEqual({ acquired: false });
      }
      expect(entered).toBe(false);
      expect(await findCycleLockHolder(getDb())).not.toBeNull();
    });
  } finally {
    await connection.sql.end({ timeout: 5 });
  }
  expect(await findCycleLockHolder(getDb())).toBeNull();
});
