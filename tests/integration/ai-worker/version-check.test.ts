import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { currentConfigVersion, getUserConfigPath, type ConfigName } from "@/lib/config";
import { createCycle, finishCycle, getControlRequest, insertControlRequest } from "@/lib/db";
import { createConnection } from "@/lib/db/client";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";

/**
 * The real worker (`src/ai-worker/index.ts`) against a config file newer than its code: an upgrade is under way and this
 * is the old worker. It stops without putting back or claiming a request. A database of its own, a `claude` stub, and
 * the worker's environment holds nothing of this machine's.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const WORKER = path.join(REPO, "src/ai-worker/index.ts");
const CLAUDE_FIXTURE = path.join(REPO, "tests/fixtures/ai/claude-success-structured.json");

let iso: IsolatedDb;
let conn: ReturnType<typeof createConnection>;
let temp: TempConfig;

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "versioncheck");
  conn = createConnection(iso.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await conn?.sql.end({ timeout: 2 });
  await iso?.drop();
});

beforeEach(async () => {
  temp = makeTempConfig({ user: "init" });
  fs.cpSync(path.join(temp.defaultsDir, "profile.example"), temp.profileDir, { recursive: true });
  await conn.db.execute(sql`delete from control_requests`);
});

afterEach(() => {
  temp.cleanup();
});

function workerEnv(): NodeJS.ProcessEnv {
  const home = path.join(temp.root, "home");
  const bin = path.join(temp.root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ncat "${CLAUDE_FIXTURE}"\n`, { mode: 0o755 });
  return {
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: home,
    TMPDIR: home,
    VITEST: process.env.VITEST ?? "true", // keeps the test database guard on in the worker
    NODE_ENV: "test",
    DATABASE_URL: iso.url,
    DB_CONNECT_TIMEOUT_SECONDS: "30",
    JOB_RADAR_DATA_ROOT: temp.root,
    JOB_RADAR_DEFAULTS_DIR: temp.defaultsDir,
    JOB_RADAR_CONFIG_DIR: temp.configDir,
    JOB_RADAR_PROFILE_DIR: temp.profileDir,
    TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
  };
}

function runOnce(): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, ["--import", LOADER, WORKER, "--once"], { cwd: REPO, env: workerEnv(), encoding: "utf8", timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** The file as a newer version of the code would have written it. */
function makeNewer(name: ConfigName): void {
  const file = getUserConfigPath(name);
  const version = currentConfigVersion(name) + 1;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text.replace(/^config_version:.*\n/m, "")}\nconfig_version: ${version}\n`);
}

async function pendingRunAi(): Promise<number> {
  const cycle = await createCycle(conn.db, { kind: "manual" });
  await finishCycle(conn.db, cycle.id, { status: "succeeded", summary: { steps: [] } });
  const request = await insertControlRequest(conn.db, { kind: "run_ai", payload: { cycleId: cycle.id } });
  return request.id;
}

/** A request left `running` by a worker that died. */
async function interruptedRunAi(): Promise<number> {
  const id = await pendingRunAi();
  await conn.db.execute(sql`update control_requests set status = 'running', started_at = now() where id = ${id}`);
  return id;
}

const statusOf = async (id: number): Promise<string | undefined> => (await getControlRequest(conn.db, id))?.status;

describe("the worker and a config file newer than its code", () => {
  it.each(["notify", "ui", "me"] as const)("%s newer at start-up: exit 1, nothing put back, nothing claimed", async (name) => {
    const running = await interruptedRunAi();
    const pending = await pendingRunAi();
    makeNewer(name);

    const { status, output } = runOnce();

    expect(status, output).toBe(1);
    expect(output).toContain("config files newer than this code");
    expect(output).toContain(`${name} v${currentConfigVersion(name) + 1}`);
    expect(await statusOf(running)).toBe("running");
    expect(await statusOf(pending)).toBe("pending");
  }, 90_000);

  it("newer while it runs: it exits before the next claim, and the queued request stays queued", async () => {
    const ai = path.join(temp.configDir, "ai.yaml");
    const text = fs.readFileSync(fs.existsSync(ai) ? ai : path.join(temp.defaultsDir, "ai.yaml"), "utf8");
    fs.writeFileSync(ai, text.replace(/already_running_wait_seconds: \d+/, "already_running_wait_seconds: 0").replace(/poll_seconds: \d+/, "poll_seconds: 1"));

    const child = spawn(process.execPath, ["--import", LOADER, WORKER], { cwd: REPO, env: workerEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      const until = Date.now() + 45_000;
      while (!output.includes("polling interactive and batch lanes")) {
        if (child.exitCode !== null) throw new Error(`the worker exited early: ${output}`);
        if (Date.now() > until) throw new Error(`the worker did not start: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      makeNewer("notify");
      const pending = await pendingRunAi();
      expect(await exited, output).toBe(1);
      expect(output).toContain("config files newer than this code");
      expect(await statusOf(pending)).toBe("pending");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 90_000);

  it("files at this code's version: it puts back what was interrupted and handles the queue, exit 0", async () => {
    const running = await interruptedRunAi();
    const pending = await pendingRunAi();

    const { status, output } = runOnce();

    expect(status, output).toBe(0);
    expect(output).not.toContain("config files newer than this code");
    expect(output).toContain("queued 1 interrupted request(s) again");
    expect(await statusOf(running)).toBe("done");
    expect(await statusOf(pending)).toBe("done");
  }, 90_000);

  it("a file with an older version does not stop it", async () => {
    const pending = await pendingRunAi();
    const file = getUserConfigPath("notify");
    fs.writeFileSync(file, fs.readFileSync(path.join(REPO, "tests/fixtures/config/notify.v1.yaml"), "utf8").replace(/^(?!config_version)/, "config_version: 1\n"));

    const { status, output } = runOnce();

    expect(output).not.toContain("config files newer than this code");
    expect(status, output).toBe(0);
    expect(await statusOf(pending)).toBe("done");
  }, 90_000);
});
