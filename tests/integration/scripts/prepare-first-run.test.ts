import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { loadConfig, resetConfigCache } from "@/lib/config";
import { CONFIG_WRITE_LOCK_KEY } from "@/lib/db/config-write-lock";
import { readSetupState, resetSetupStateCache } from "@/lib/setup";

import { FIXTURE_DEFAULTS_DIR } from "../../config/helpers";
import { connect, waitUntil } from "../config/write-lock-helpers";

/**
 * The prepare scripts on a target database that does not exist yet: they create and migrate it before writing any config,
 * because the config write lock lives in that database. The real scripts in processes of their own, on the disposable
 * test server. Their names are the ones they accept (`jobradar_e2e*`, `jobradar_demo*`, both refuse anything else; the last
 * test pins that) and every directory is in a temp directory.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const [K1, K2] = CONFIG_WRITE_LOCK_KEY;
const E2E_DB = `jobradar_e2e_prepfirst_${process.pid}`;
const DEMO_DB = `jobradar_demo_prepfirst_${process.pid}`;

let adminUrl = "";
let admin: Sql;
let root = "";
let configDir = "";
let profileDir = "";
let pauseDir = "";
const CONFIG_ENV = ["JOB_RADAR_DEFAULTS_DIR", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR"] as const;
const savedEnv = new Map(CONFIG_ENV.map((key) => [key, process.env[key]]));

interface Run {
  /** Exit code. */
  exited: Promise<number | null>;
  output: () => string;
  isRunning: () => boolean;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, ["--import", LOADER, path.join(REPO, "scripts", script), ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  return { exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))), output: () => out, isRunning: () => child.exitCode === null && child.signalCode === null };
}

const urlOf = (db: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
};

const dropDb = (db: string): Promise<unknown> => admin.unsafe(`drop database if exists "${db}" with (force)`);

const dbExists = async (db: string): Promise<boolean> => (await admin`select 1 from pg_database where datname = ${db}`).length > 0;

/** Sessions holding the config write lock, with the database they hold it in. */
async function lockDatabases(): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`
    select d.datname from pg_locks l join pg_database d on d.oid = l.database
    where l.locktype = 'advisory' and l.granted and l.classid = ${K1}::int::oid and l.objid = ${K2}::int::oid and l.objsubid = 2 and d.datname in (${E2E_DB}, ${DEMO_DB})`;
  return rows.map((row) => row.datname);
}

/** Point this process's reader at the directories a script just filled. */
function readDirectories(defaults: string): void {
  process.env.JOB_RADAR_DEFAULTS_DIR = defaults;
  process.env.JOB_RADAR_CONFIG_DIR = configDir;
  process.env.JOB_RADAR_PROFILE_DIR = profileDir;
  resetConfigCache();
  resetSetupStateCache();
}

/**
 * Let the run pass the first commit, and look at the lock while it is stopped there. A first commit means a lock session,
 * which means the database was there already: the name it returns is where the lock was.
 */
async function lockAtFirstCommit(run: Run): Promise<string[]> {
  const reached = path.join(pauseDir, "reached");
  await waitUntil("the first config commit", () => {
    if (!run.isRunning()) throw new Error(`the script ended before its first commit: ${run.output()}`);
    return fs.existsSync(reached);
  }, 60_000);
  const databases = await lockDatabases();
  fs.writeFileSync(path.join(pauseDir, "go"), "");
  return databases;
}

const pauseEnv = (): Record<string, string> => ({ NODE_ENV: "test", JOB_RADAR_TEST_LOCK_PAUSE: `after-hash-check:${pauseDir}` });

beforeAll(() => {
  const url = new URL(inject("testDatabaseUrl"));
  url.pathname = "/postgres";
  adminUrl = url.toString();
  admin = connect(adminUrl);
});

afterAll(async () => {
  await dropDb(E2E_DB);
  await dropDb(DEMO_DB);
  await admin?.end({ timeout: 2 });
  for (const key of CONFIG_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
});

beforeEach(async () => {
  // the name is what demo-prepare's own check asks for; the e2e script takes any directory it is given
  root = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-demo-prepfirst-"));
  configDir = path.join(root, "config");
  profileDir = path.join(root, "profile");
  pauseDir = path.join(root, "pause");
  fs.mkdirSync(pauseDir);
  await dropDb(E2E_DB);
  await dropDb(DEMO_DB);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function e2eEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    E2E_ADMIN_DATABASE_URL: adminUrl,
    DATABASE_URL: urlOf(E2E_DB),
    JOB_RADAR_DEFAULTS_DIR: FIXTURE_DEFAULTS_DIR,
    JOB_RADAR_CONFIG_DIR: configDir,
    JOB_RADAR_PROFILE_DIR: profileDir,
    TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
    ...extra,
  };
}

function demoEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_ADMIN_DATABASE_URL: adminUrl,
    DEMO_DB_NAME: DEMO_DB,
    DEMO_CONFIG_DIR: configDir,
    DEMO_PROFILE_DIR: profileDir,
    TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
    ...extra,
  };
  delete env.VITEST; // the test database guard refuses the demo's name, and the demo is not a test database
  delete env.JOB_RADAR_CONFIG_DIR;
  delete env.JOB_RADAR_PROFILE_DIR;
  delete env.JOB_RADAR_DEFAULTS_DIR;
  return env;
}

describe("the prepare scripts on a database that does not exist yet", () => {
  it("e2e-prepare: creates and migrates it, takes the lock in it, and the install is set up with the run's values", async () => {
    expect(await dbExists(E2E_DB)).toBe(false);

    const run = runScript("e2e-prepare.ts", [], e2eEnv(pauseEnv()));
    expect(await lockAtFirstCommit(run)).toEqual([E2E_DB]);
    expect(await run.exited, run.output()).toBe(0);

    readDirectories(FIXTURE_DEFAULTS_DIR);
    expect(readSetupState().pending).toBe(false);
    expect(loadConfig("breakdown").enabled).toBe(true);
    expect(loadConfig("salary").lookup.enabled).toBe(true);
    expect(loadConfig("salary").benchmark.min_sample).toBe(2);
    expect(await lockDatabases()).toEqual([]);
  }, 120_000);

  it("e2e-prepare --fresh: creates and migrates it, leaves both directories there and empty, setup pending, no lock session ever", async () => {
    // Something old in the directories: a fresh install has none of it.
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "stale.yaml"), "x: 1\n");

    const run = runScript("e2e-prepare.ts", ["--fresh"], e2eEnv(pauseEnv()));
    expect(await run.exited, run.output()).toBe(0);

    expect(await dbExists(E2E_DB)).toBe(true);
    const migrated = connect(urlOf(E2E_DB));
    try {
      expect((await migrated`select to_regclass('public.control_requests') as table`)[0]?.table).toBe("control_requests");
    } finally {
      await migrated.end({ timeout: 2 });
    }
    expect(fs.readdirSync(configDir)).toEqual([]);
    expect(fs.readdirSync(profileDir)).toEqual([]);
    expect(fs.existsSync(path.join(pauseDir, "reached")), "--fresh writes no config, so it never reaches a commit").toBe(false);
    readDirectories(FIXTURE_DEFAULTS_DIR);
    expect(readSetupState().pending).toBe(true);
  }, 120_000);

  it("demo-prepare: creates and migrates it, takes the lock in it, and the install is set up with the demo's values", async () => {
    expect(await dbExists(DEMO_DB)).toBe(false);

    const run = runScript("demo-prepare.ts", [], demoEnv(pauseEnv()));
    expect(await lockAtFirstCommit(run)).toEqual([DEMO_DB]);
    expect(await run.exited, run.output()).toBe(0);

    readDirectories(path.join(REPO, "config"));
    expect(readSetupState().pending).toBe(false);
    expect(loadConfig("search").locations).toEqual(["Berlin"]);
    expect(loadConfig("channels").linkedin.brightdata.enabled).toBe(false);
    expect(loadConfig("schedule").timezone).toBe("Europe/Berlin");
    expect(loadConfig("notify").public_base_url).toBe("http://127.0.0.1:3000");
    expect(loadConfig("ui").applications.hidden_statuses).toEqual([]);
    expect(await lockDatabases()).toEqual([]);

    // --drop leaves nothing behind
    const drop = runScript("demo-prepare.ts", ["--drop"], demoEnv());
    expect(await drop.exited, drop.output()).toBe(0);
    expect(await dbExists(DEMO_DB)).toBe(false);
    expect(fs.existsSync(configDir)).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(false);
  }, 120_000);

  it("a name or a directory they do not accept: they stop before they touch anything", async () => {
    const target = "jobradar_test_prepfirst_refused";
    const e2e = runScript("e2e-prepare.ts", [], e2eEnv({ DATABASE_URL: urlOf(target) }));
    expect(await e2e.exited).toBe(2);
    expect(e2e.output()).toContain("must start with jobradar_e2e");
    expect(await dbExists(target)).toBe(false);

    const outside = path.join(root, "..", "not-the-demo-prepfirst");
    const demo = runScript("demo-prepare.ts", [], demoEnv({ DEMO_CONFIG_DIR: outside }));
    expect(await demo.exited).toBe(2);
    expect(await dbExists(DEMO_DB)).toBe(false);

    const fresh = runScript("e2e-prepare.ts", ["--fresh"], { ...e2eEnv(), JOB_RADAR_PROFILE_DIR: "" });
    expect(await fresh.exited).toBe(2);
    expect(await dbExists(E2E_DB)).toBe(false);
  }, 120_000);
});
