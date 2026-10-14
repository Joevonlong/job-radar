// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { releasesLockCheck, swapBackupCheck } from "@/lib/ops/doctor/checks/ops";
import { parseInflightRecord, parseLockOwner, readReleasesLock, RELEASES_PS_COMMAND } from "@/lib/ops/releases-lock";

import { makeContext, NOW, only } from "./doctor/helpers";

/**
 * The doctor's `ops.releases_lock` and `ops.ai_worker_swap_backup` with the real file reader against a throw-away
 * checkout, and the TypeScript reader against scripts/ops/lib/releases.sh on the same fixtures (the same answers).
 */
const repo = path.resolve(import.meta.dirname, "../..");
const releasesSh = path.join(repo, "scripts/ops/lib/releases.sh");
const ownerFixture = fs.readFileSync(path.join(repo, "tests/fixtures/ops/lock-owner-wrapper.txt"), "utf8");
const recordFixture = fs.readFileSync(path.join(repo, "tests/fixtures/ops/inflight-wrapper.txt"), "utf8");
const FIXTURE_TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";

let main = "";
let lock = "";
beforeEach(() => {
  main = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-lock-"));
  lock = path.join(main, "data/releases/ai-worker/.lock");
});
afterEach(() => {
  if (main !== "" && path.basename(main).startsWith("doctor-lock-")) fs.rmSync(main, { recursive: true, force: true });
});

function placeLock(owner: string | null, records: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(lock, "inflight"), { recursive: true });
  if (owner !== null) fs.writeFileSync(path.join(lock, "owner"), owner);
  for (const [name, content] of Object.entries(records)) fs.writeFileSync(path.join(lock, "inflight", name), content);
}

function bash(snippet: string): string {
  const env = { ...process.env };
  delete env.JOB_RADAR_RELEASES_LOCK_TOKEN;
  const r = spawnSync("/bin/bash", ["-c", `set -u; source "${releasesSh}"; ${snippet}`], { encoding: "utf8", env: { ...env, MAIN: main }, timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const deadPid = (): number => Number(spawnSync("/bin/bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());

/** A context whose probes read the real lock under `main`; `started` of the fixture is far before NOW. */
const context = (env: Record<string, string | undefined> = {}, locale: "en" | "zh" = "en") =>
  makeContext({ locale, env, probes: { releasesLock: async () => readReleasesLock(main) } });

describe("the TypeScript reader matches releases.sh", () => {
  it("prints the same ps command", () => {
    expect(bash('printf "%s" "$RELEASES_PS_COMMAND"')).toBe(RELEASES_PS_COMMAND);
  });

  it.each([
    ["the fixture", ownerFixture],
    ["no final newline", ownerFixture.trimEnd()],
    ["an extra line", `${ownerFixture}x=1\n`],
    ["an empty last line", `${ownerFixture}\n`],
    ["a short token", ownerFixture.replace(FIXTURE_TOKEN, "abc")],
    ["lines out of order", ownerFixture.split("\n").reverse().join("\n")],
    ["a host with a space", ownerFixture.replace("host=wrapper-host", "host=a b")],
  ])("reads an owner file the same way: %s", (_name, text) => {
    placeLock(text);
    const r = spawnSync("/bin/bash", ["-c", `source "${releasesSh}"; releases_lock_owner_read "$MAIN"`], { encoding: "utf8", env: { ...process.env, MAIN: main } });
    expect(parseLockOwner(text) !== null).toBe(r.status === 0);
  });

  it("lists the in-flight records the same way (fixture, unreadable entries, .tmp-*, a link)", async () => {
    const dead = deadPid();
    placeLock(ownerFixture, {
      "999999": recordFixture,
      [String(dead)]: `script=deploy.sh\npid=${dead}\nstarted=1\n`,
      [String(process.pid)]: `script=install-ai-worker.sh\npid=${process.pid}\nstarted=2\n\n`,
      reordered: "script=a\nstarted=3\npid=4\n",
      junk: "x\n",
      "bad-name": "script=a b\npid=1\nstarted=1\n",
      ".tmp-5": "script=a\n",
    });
    fs.symlinkSync(path.join(lock, "inflight", "999999"), path.join(lock, "inflight", "link"));
    const fromBash = bash('releases_inflight_list "$MAIN"').split("\n").filter(Boolean).sort();
    const state = await readReleasesLock(main);
    if (!state.present) throw new Error("lock not seen");
    const fromTs = state.records
      .map((e) => (e.kind === "record" ? `${e.name} ${e.pid} ${e.script} ${e.started} ${e.alive ? "alive" : "gone"}` : `${e.name} ${e.kind}`))
      .sort();
    expect(fromTs).toEqual(fromBash);
    expect(fromTs).toContain(`${dead} ${dead} deploy.sh 1 gone`);
    expect(fromTs).toContain(`${process.pid} ${process.pid} install-ai-worker.sh 2 alive`);
    expect(parseInflightRecord(recordFixture)).toEqual({ script: "deploy-prod.sh", pid: 999999, started: 1760000000 });
  });
});

describe("ops.releases_lock", () => {
  it("is ok without a lock", async () => {
    const r = await only(releasesLockCheck, context());
    expect(r).toMatchObject({ id: "ops.releases_lock", group: "host", status: "ok" });
    expect(r.detail).toBe("No release lock (no deploy or worker install is running)");
  });

  it("warns for a left-behind lock with owner, age, records and how to clear it; never the token", async () => {
    const dead = deadPid();
    placeLock(ownerFixture, { [String(dead)]: `script=deploy.sh\npid=${dead}\nstarted=1\n`, odd: "?", ".tmp-9": "" });
    const r = await only(releasesLockCheck, context());
    expect(r.status).toBe("warn");
    const held = Math.floor(NOW.getTime() / 1000) - 1760000000;
    expect(held).toBeGreaterThan(0);
    expect(r.detail).toContain(`The release lock ${lock} exists: pid 999999 on wrapper-host, held for `);
    expect(r.detail).toContain(`${dead} (deploy.sh, pid ${dead} gone)`);
    expect(r.detail).toContain("odd (unreadable)");
    expect(r.detail).toContain(".tmp-9 (half-written)");
    expect(r.hint).toContain(RELEASES_PS_COMMAND);
    expect(r.hint).toContain(`rm -rf ${lock}`);
    expect(r.hint).toContain("dependency install (pnpm install), migration, config write, drain or install");
    expect(JSON.stringify(r)).not.toContain(FIXTURE_TOKEN);
  });

  it("is ok, without a clear command, when the lock is the current deploy's (same token in the environment)", async () => {
    placeLock(ownerFixture, { "999999": recordFixture });
    const r = await only(releasesLockCheck, context({ JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN }));
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/^Held by the current deploy \(pid 999999 on wrapper-host, for .+\); in-flight records: 999999 \(deploy-prod\.sh, pid 999999 (gone|still running)\)$/);
    expect(r.hint).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(FIXTURE_TOKEN);
  });

  it.each([
    ["another token", { JOB_RADAR_RELEASES_LOCK_TOKEN: OTHER_TOKEN }],
    ["an empty token", { JOB_RADAR_RELEASES_LOCK_TOKEN: "" }],
    ["no token", {}],
  ])("warns for the same lock with %s", async (_name, env) => {
    placeLock(ownerFixture);
    const r = await only(releasesLockCheck, context(env));
    expect(r.status).toBe("warn");
    expect(r.hint).toContain(`rm -rf ${lock}`);
    expect(r.detail).toContain("in-flight records: none");
  });

  it("warns when the owner cannot be read, even with a token in the environment", async () => {
    placeLock("broken\n");
    const r = await only(releasesLockCheck, context({ JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("its owner is unknown");
    placeLock(null);
    fs.rmSync(path.join(lock, "owner"), { force: true });
    expect((await only(releasesLockCheck, context())).detail).toContain("its owner is unknown");
  });

  it("speaks Chinese in a Chinese report", async () => {
    placeLock(ownerFixture);
    const r = await only(releasesLockCheck, context({}, "zh"));
    expect(r.detail).toContain("发布锁");
    expect(r.hint).toContain(RELEASES_PS_COMMAND);
  });
});

describe("ops.ai_worker_swap_backup", () => {
  const backupContext = () =>
    makeContext({
      locale: "en",
      probes: {
        listDir: async (dir: string) => {
          try {
            return fs.readdirSync(dir);
          } catch {
            return null;
          }
        },
      },
    });

  it("is ok without data/run or without a backup, and warns with the location when one is left", async () => {
    const ctx = backupContext();
    Object.assign(ctx, { appRoot: main });
    expect((await only(swapBackupCheck, ctx)).status).toBe("ok");
    fs.mkdirSync(path.join(main, "data/run/other"), { recursive: true });
    expect((await only(swapBackupCheck, ctx)).status).toBe("ok");
    fs.mkdirSync(path.join(main, "data/run/ai-worker-swap-backup"));
    const r = await only(swapBackupCheck, ctx);
    const dir = `${main}/data/run/ai-worker-swap-backup`;
    expect(r).toMatchObject({ id: "ops.ai_worker_swap_backup", status: "warn" });
    expect(r.detail).toContain(dir);
    expect(r.hint).toContain(`${dir}/state`);
    expect(r.hint).toContain(`rm -rf ${dir}`);
  });
});
