import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import postgres, { type Sql } from "postgres";
import { parseDocument } from "yaml";

import { CONFIG_WRITE_LOCK_KEY } from "@/lib/db/config-write-lock";
import { layeredConfigFingerprint, type ConfigName } from "@/lib/config";

import type { TempConfig } from "../../config/helpers";

/** Writers in processes of their own against a real Postgres, stopped through `JOB_RADAR_TEST_LOCK_PAUSE`. */
export const REPO = path.resolve(import.meta.dirname, "../../..");
const LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const CHILD = path.join(REPO, "tests/fixtures/config/write-lock-child.ts");

export const NOTIFY_V1 = fs.readFileSync(path.join(REPO, "tests/fixtures/config/notify.v1.yaml"), "utf8");

export interface Started {
  proc: ChildProcess;
  pid: number;
  output: () => string;
  /** The exit code; null when a signal ended it. */
  exited: Promise<number | null>;
}

/** The environment of a child: this temp config, this database, the test mode that makes the pause stages work. */
export function childEnv(temp: TempConfig, url: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: url,
    JOB_RADAR_DEFAULTS_DIR: temp.defaultsDir,
    JOB_RADAR_CONFIG_DIR: temp.configDir,
    JOB_RADAR_PROFILE_DIR: temp.profileDir,
    TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
    ...extra,
  };
}

const started: Started[] = [];

function start(args: string[], env: NodeJS.ProcessEnv): Started {
  const proc = spawn(process.execPath, ["--import", LOADER, ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  const child = { proc, pid: proc.pid ?? 0, output: () => out, exited };
  started.push(child);
  return child;
}

/** A form or editor save in a child process (`tests/fixtures/config/write-lock-child.ts`). */
export function startWriter(action: Record<string, unknown>, env: NodeJS.ProcessEnv): Started {
  return start([CHILD, JSON.stringify(action)], env);
}

/** A real command of `scripts/`. */
export function startScript(script: string, args: string[], env: NodeJS.ProcessEnv): Started {
  return start([path.join(REPO, "scripts", script), ...args], env);
}

/** Runs a real command of `scripts/` to its end. */
export function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", LOADER, path.join(REPO, "scripts", script), ...args], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** For `afterEach`: nothing a failed test left behind keeps holding the lock. */
export async function stopChildren(): Promise<void> {
  for (const child of started.splice(0)) {
    if (child.proc.exitCode === null && child.proc.signalCode === null) {
      child.proc.kill("SIGKILL");
      await child.exited;
    }
  }
}

export async function waitUntil(what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Parsed last output line of a finished writer child. */
export async function resultOf(child: Started): Promise<{ status: string; kind?: string; detail?: string | null }> {
  const code = await child.exited;
  const last = child.output().trim().split("\n").at(-1) ?? "";
  if (code !== 0) throw new Error(`the writer exited ${code}: ${child.output()}`);
  return JSON.parse(last) as { status: string; kind?: string; detail?: string | null };
}

/** A pause point: `env` for the child, and the test's side of it. */
export interface Pause {
  env: Record<string, string>;
  reached: () => boolean;
  /** Wait until the child stopped there. Fails at once when it exited instead. */
  waitReached: (child: Started) => Promise<void>;
  go: () => void;
}

export function makePause(root: string, stage: "after-hash-check" | "after-fence" | "before-publish"): Pause {
  const dir = fs.mkdtempSync(path.join(root, "pause-"));
  const reached = (): boolean => fs.existsSync(path.join(dir, "reached"));
  return {
    env: { JOB_RADAR_TEST_LOCK_PAUSE: `${stage}:${dir}` },
    reached,
    waitReached: (child) => waitUntil(`the writer to stop at ${stage}`, () => {
      if (child.proc.exitCode !== null) throw new Error(`the writer exited (${child.proc.exitCode}) before ${stage}: ${child.output()}`);
      return reached();
    }),
    go: () => fs.writeFileSync(path.join(dir, "go"), ""),
  };
}

export function connect(url: string): Sql {
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** Backends of a child's lock connection (waiting or holding): its `application_name` carries the child's pid. */
export async function lockSessionsOf(sql: Sql, childPid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_stat_activity where datname = current_database() and application_name like ${`job-radar config-write pid=${childPid} %`}`;
  return rows.map((row) => row.pid);
}

/** The backend holding the config write lock in this database; null when nobody does. */
export async function lockHolder(sql: Sql): Promise<number | null> {
  const [k1, k2] = CONFIG_WRITE_LOCK_KEY;
  const rows = await sql<{ pid: number }[]>`
    select pid from pg_locks
    where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())
      and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2`;
  return rows[0]?.pid ?? null;
}

/** Wait until `child` asks for the lock over its own session, while another session holds it. */
export async function waitForWaiter(sql: Sql, child: Started): Promise<void> {
  await waitUntil(`process ${child.pid} to ask for the lock`, async () => {
    if (child.proc.exitCode !== null) throw new Error(`the waiter exited (${child.proc.exitCode}): ${child.output()}`);
    return (await lockSessionsOf(sql, child.pid)).length > 0;
  });
  const holder = await lockHolder(sql);
  if (holder === null || (await lockSessionsOf(sql, child.pid)).includes(holder)) throw new Error(`process ${child.pid} is not waiting`);
}

/** A config directory a form could open: every profile file present, `lock_wait_seconds` as the test needs. */
export function prepareInstall(temp: TempConfig, lockWaitSeconds: number): void {
  fs.cpSync(path.join(temp.defaultsDir, "profile.example"), temp.profileDir, { recursive: true });
  setConfigValue(temp, "schedule.yaml", ["config_writes"], { backups_keep: 5, lock_wait_seconds: lockWaitSeconds });
}

export function setConfigValue(temp: TempConfig, file: string, at: string[], value: unknown): void {
  const target = path.join(temp.configDir, file);
  const doc = parseDocument(fs.readFileSync(target, "utf8"));
  doc.setIn(at, doc.createNode(value));
  fs.writeFileSync(target, doc.toString());
}

/** The hash a form or the editor opened on `file` holds (the temp directories are this process's, too). */
export function textHash(_temp: TempConfig, file: string): string {
  return layeredConfigFingerprint(file.replace(/\.yaml$/, "") as ConfigName);
}

/** Temp files of a commit that did not finish. */
export function tempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}
