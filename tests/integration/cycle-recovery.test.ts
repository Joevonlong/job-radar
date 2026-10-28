import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { ChannelRegistry } from "@/lib/channels/registry";
import { findCycleLockHolder, withCycleLock } from "@/lib/cycle/lock";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, countRunningCycles, createConnection, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const root = path.resolve(import.meta.dirname, "../..");
let temp: TempConfig;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
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
  const [company] = await getDb().insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  await getDb().insert(schema.jobs).values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer", workplace: "remote" });
  let processRun: ReturnType<typeof cli> | undefined;
  try {
    await withCycleLock(getDb(), "try", async () => {
      processRun = cli("scripts/reprocess.ts");
      await vi.waitFor(async () => {
        const [waiting] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and not l.granted and l.database = (select oid from pg_database where datname = current_database()) and a.application_name like ${`job-radar cycle pid=${processRun!.child.pid} %`}`);
        expect(waiting?.n === 1 || processRun!.output().includes("work mode, German level and agency flag cleared")).toBe(true);
      }, { timeout: 15_000 });
      expect((await getDb().select().from(schema.jobs))[0]?.workplace).toBe("remote");
    });
  } finally {
    if (processRun) expect(await processRun.finished, processRun.output()).toEqual({ code: 0, signal: null });
  }
  expect((await getDb().select().from(schema.jobs))[0]?.workplace).toBe("unknown");
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
    const rows = await getDb().select().from(schema.cycles);
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
  await getDb().execute(sql`create sequence fail_cycle_finish_once`);
  await getDb().execute(sql`create function fail_cycle_finish_once() returns trigger language plpgsql as $$ begin if old.status = 'running' and new.status <> 'running' and nextval('fail_cycle_finish_once') = 1 then raise exception 'test finish failure'; end if; return new; end $$`);
  await getDb().execute(sql`create trigger fail_cycle_finish_once before update on cycles for each row execute function fail_cycle_finish_once()`);
  // No collectors or AI: exercise just the cycle row's lifecycle and its real finish write.
  for (const name of ["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"] as const) registerCycleStep(name, async () => {});
  const run = () => runCycle("manual", { registry: new ChannelRegistry(), config: config(), logger: quietLogger });
  try {
    await expect(run()).rejects.toThrow();
    const [orphan] = await getDb().select().from(schema.cycles);
    expect(orphan?.status).toBe("running");
    expect((await run()).status).toBe("succeeded");
    const [recovered] = await getDb().select().from(schema.cycles).where(eq(schema.cycles.id, orphan!.id));
    expect(recovered).toMatchObject({ status: "failed", summaryJson: { orphaned: expect.any(String) } });
    expect(recovered?.finishedAt).toBeInstanceOf(Date);
    expect(await countRunningCycles(getDb())).toBe(0);
  } finally {
    await getDb().execute(sql`drop trigger fail_cycle_finish_once on cycles`);
    await getDb().execute(sql`drop function fail_cycle_finish_once()`);
    await getDb().execute(sql`drop sequence fail_cycle_finish_once`);
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
    await getDb().execute(sql`select pg_terminate_backend(${pid})`);
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
      await connection.db.execute(sql`select 1`);
      const waiting = withCycleLock(getDb(), "wait", async () => { entered = true; }, { signal: abort.signal });
      try {
        await vi.waitFor(async () => {
          const [row] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
          expect(row?.n).toBe(1);
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
