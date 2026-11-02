// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfigText } from "@/lib/config";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";
import { ensurePendingSetupFile, readSetupState, resetSetupStateCache } from "@/lib/setup/state";

import { inProcessConfigWriteLock } from "../config/in-process-lock";
import { makeTempConfig, waitFor, type TempConfig } from "../config/helpers";
import { LOCK_STAND_IN } from "../config/run-script";

let tmp: TempConfig;
const REPO = path.resolve(import.meta.dirname, "../..");
const setupFile = () => path.join(tmp.configDir, "setup.yaml");
const temps = () => fs.readdirSync(tmp.configDir).filter((name) => name.startsWith(".setup.yaml.") && name.endsWith(".tmp"));
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => {
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

describe("ensurePendingSetupFile", () => {
  it("creates setup.yaml from the shipped default, pending, and says it did not exist", async () => {
    expect(readSetupState().pending).toBe(true);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: false });
    expect(fs.readFileSync(setupFile(), "utf8")).toBe(fs.readFileSync(path.join(tmp.defaultsDir, "setup.yaml"), "utf8"));
    expect(parseConfigText("setup", fs.readFileSync(setupFile(), "utf8")).completed_at).toBeNull();
    expect(readSetupState()).toMatchObject({ pending: true, source: "user" });
    expect(fs.statSync(setupFile()).mode & 0o777).toBe(0o600);
    expect(temps()).toEqual([]);
  });

  it("a second call finds it", async () => {
    await ensurePendingSetupFile();
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
  });

  it("never overwrites a file that exists, completed or not", async () => {
    const completed = 'config_version: 1\ncompleted_at: "2026-09-01T00:00:00.000Z"\ncompleted_by: wizard\n';
    fs.writeFileSync(setupFile(), completed);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
    expect(fs.readFileSync(setupFile(), "utf8")).toBe(completed);
    expect(readSetupState().pending).toBe(false);
  });

  it("two calls at once make one complete file: one creates it, the other finds it", async () => {
    const results = await Promise.all([ensurePendingSetupFile(), ensurePendingSetupFile()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.existed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.existed)).toHaveLength(1);
    expect(fs.readFileSync(setupFile(), "utf8")).toBe(fs.readFileSync(path.join(tmp.defaultsDir, "setup.yaml"), "utf8"));
    expect(temps()).toEqual([]);
  });

  it("a file that appears between the check and the publish stays: the commit never replaces", async () => {
    // the ownership check runs right before the publish: another writer's file lands there
    const intruder = "completed_at: null\n# somebody else\n";
    setConfigWriteLockProviderForTests(async () => ({
      acquired: true,
      lock: { fence: async () => { fs.writeFileSync(setupFile(), intruder); return true; }, release: async () => {} },
    }));
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
    expect(fs.readFileSync(setupFile(), "utf8")).toBe(intruder);
    expect(temps()).toEqual([]);
  });

  it("does not publish a shipped default that does not read back as a valid setup.yaml", async () => {
    fs.writeFileSync(path.join(tmp.defaultsDir, "setup.yaml"), "completed_at: tomorrow\n");
    resetSetupStateCache();
    expect(await ensurePendingSetupFile()).toEqual({ ok: false, formError: "setupUnreadable" });
    expect(fs.existsSync(setupFile())).toBe(false);
    expect(temps()).toEqual([]);
  });

  it("reports a missing shipped default as `setupUnreadable` and a held lock as `busy`", async () => {
    fs.rmSync(path.join(tmp.defaultsDir, "setup.yaml"));
    expect(await ensurePendingSetupFile()).toEqual({ ok: false, formError: "setupUnreadable" });
    setConfigWriteLockProviderForTests(async () => ({ acquired: false, holder: "other" }));
    expect(await ensurePendingSetupFile()).toEqual({ ok: false, formError: "busy" });
  });
});

describe("temp files an interrupted write left", () => {
  const leftover = (name: string, ageMs: number) => {
    const file = path.join(tmp.configDir, name);
    fs.writeFileSync(file, "half");
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };

  it("removes the old ones of setup.yaml before it creates the file, and only those", async () => {
    const old = leftover(".setup.yaml.4242.deadbeef.tmp", HOUR_MS + 60_000);
    const young = leftover(".setup.yaml.4243.cafebabe.tmp", 60_000);
    const other = leftover(".language.yaml.4242.deadbeef.tmp", 2 * HOUR_MS);
    const notTemp = leftover(".setup.yaml.notes", 2 * HOUR_MS);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: false });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(notTemp)).toBe(true);
    expect(fs.existsSync(setupFile())).toBe(true);
  });

  it("also cleans up when setup.yaml already exists", async () => {
    fs.writeFileSync(setupFile(), "completed_at: null\n");
    const old = leftover(".setup.yaml.4242.deadbeef.tmp", 2 * HOUR_MS);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
    expect(fs.existsSync(old)).toBe(false);
  });
});

describe("a process killed in the middle of the first write", () => {
  /** Run `ensurePendingSetupFile` in a child that stops right before it publishes. */
  async function startPaused(gate: string) {
    fs.mkdirSync(gate, { recursive: true });
    const child = spawn(process.execPath, ["--import", LOCK_STAND_IN, "--import", path.join(REPO, "node_modules/tsx/dist/loader.mjs"), path.join(REPO, "tests/fixtures/setup/ensure-pending-child.ts")], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
        JOB_RADAR_TEST_LOCK_PAUSE: `before-publish:${gate}`,
        JOB_RADAR_CONFIG_DIR: tmp.configDir,
        JOB_RADAR_PROFILE_DIR: tmp.profileDir,
        JOB_RADAR_DEFAULTS_DIR: tmp.defaultsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(await waitFor(() => fs.existsSync(path.join(gate, "reached")), 20_000), `the child never reached the pause: ${output}`).toBe(true);
    return { child, closed };
  }

  it("leaves no setup.yaml (pending), and the next call cleans the temp file up and creates it", async () => {
    const gate = path.join(tmp.root, "gate");
    const { child, closed } = await startPaused(gate);
    try {
      // the temp file is complete and the target does not exist: this is the moment of the kill
      expect(temps()).toHaveLength(1);
      expect(fs.existsSync(setupFile())).toBe(false);
      child.kill("SIGKILL");
      await closed;
    } finally {
      child.kill("SIGKILL");
    }
    expect(fs.existsSync(setupFile())).toBe(false);
    expect(readSetupState().pending).toBe(true);
    expect(temps()).toHaveLength(1);

    // the dead writer's temp file is younger than an hour: it stays until it is old enough, and does not block the next write
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: false });
    expect(temps()).toHaveLength(1);
    const [stale] = temps();
    const aged = new Date(Date.now() - HOUR_MS - 60_000);
    fs.utimesSync(path.join(tmp.configDir, stale ?? ""), aged, aged);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
    expect(temps()).toEqual([]);
    expect(parseConfigText("setup", fs.readFileSync(setupFile(), "utf8")).completed_at).toBeNull();
  });

  it("a child that is let go publishes the file itself", async () => {
    const gate = path.join(tmp.root, "gate");
    const { child, closed } = await startPaused(gate);
    try {
      fs.writeFileSync(path.join(gate, "go"), "");
      await closed;
    } finally {
      child.kill("SIGKILL");
    }
    expect(fs.existsSync(setupFile())).toBe(true);
    expect(temps()).toEqual([]);
    expect(await ensurePendingSetupFile()).toEqual({ ok: true, existed: true });
  });
});
