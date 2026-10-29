import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";

import { FakeInstall, UNINSTALL } from "../helpers/fake-release";
import { createIsolatedDb, type IsolatedDb } from "../helpers/isolated-db";
import { selectedSwapManagers } from "../helpers/swap-managers";

/**
 * scripts/ops/uninstall-ai-worker.sh against the service-manager simulator (tests/ops/sim): the worker is installed with
 * the real install script and a fake release (tests/helpers/fake-release.ts), then removed by the same identity rules.
 * Everything lives in a mkdtemp directory; the simulator's processes are killed in afterEach.
 */
const L_DEFAULT = "io.jobradar.ai-worker";
const L_LEGACY = "de.jobradar.ai-worker";
const L_CUSTOM = "com.example.ai-worker";
const managers = selectedSwapManagers(process.env.SWAP_MANAGERS);
const SLOW = 120_000;

let iso: IsolatedDb;
beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "swap");
}, 60_000);
afterAll(async () => {
  await iso?.drop();
});

describe.each(managers)("uninstall-ai-worker.sh (%s)", (manager) => {
  let fx: FakeInstall;
  afterEach(async () => {
    await fx?.cleanup();
  });

  const def = (label: string): string => (manager === "launchd" ? fx.plist(label) : fx.unitFile());
  const uninstall = () => fx.run(UNINSTALL, ["--root", fx.main]);
  function installed(label?: string): number {
    fx = new FakeInstall(manager);
    if (label) fx.setDeploy({ label });
    const r = fx.install(["--release", fx.release(), "--database-url", iso.url]);
    expect(r.status, r.stderr).toBe(0);
    const pid = fx.servicePid(label ?? L_DEFAULT);
    expect(pid).toBeGreaterThan(0);
    return pid;
  }
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it.each(manager === "launchd" ? [[L_CUSTOM], [L_DEFAULT], [L_LEGACY]] : [[undefined]])("stops and removes the definition (label %s); nothing is left", (label) => {
    const pid = installed(label);
    const r = uninstall();
    expect(r.status, r.stderr).toBe(0);
    expect(gone(pid)).toBe(true);
    expect(fs.existsSync(def(label ?? L_DEFAULT))).toBe(false);
    expect(fx.identity()).toMatchObject({ status: "0", origin: "none" });
    expect(fs.existsSync(fx.releasesDir())).toBe(true); // releases stay
    if (manager === "systemd") expect(fx.changes().slice(-3)).toEqual(["disable --now job-radar-ai-worker.service", "stop job-radar-ai-worker.service", "daemon-reload"]);
  }, SLOW);

  it.runIf(manager === "launchd")("removes a definition under the old label", () => {
    const pid = installed(L_LEGACY);
    fx.setDeploy({ label: L_DEFAULT });
    const r = uninstall();
    expect(r.status, r.stderr).toBe(0);
    expect(gone(pid)).toBe(true);
    expect(fs.existsSync(fx.plist(L_LEGACY))).toBe(false);
  }, SLOW);

  it.runIf(manager === "launchd")("an ambiguous identity: exit 1, nothing called, both definitions stay", () => {
    installed(L_LEGACY);
    fx.setDeploy({ label: L_CUSTOM });
    fs.copyFileSync(fx.plist(L_LEGACY), fx.plist(L_DEFAULT));
    const n = fx.changes().length;
    const r = uninstall();
    expect(r.status).toBe(1);
    expect(fx.changes().length).toBe(n);
    expect(fs.existsSync(fx.plist(L_LEGACY)) && fs.existsSync(fx.plist(L_DEFAULT))).toBe(true);
  }, SLOW);

  it("a worker that does not stop: the definition is kept, exit 1", () => {
    installed();
    const sha = path.basename(fx.starts()[0]?.cwd ?? "");
    fx.setModes({ [sha]: "ignore-term" });
    // restart it under ignore-term (the mode is read at start)
    if (manager === "launchd") {
      fx.sim("launchctl", "bootout", `gui/${process.getuid?.()}/${L_DEFAULT}`);
      fx.sim("launchctl", "bootstrap", `gui/${process.getuid?.()}`, def(L_DEFAULT));
    } else {
      fx.sim("systemctl", "--user", "stop", "job-radar-ai-worker.service");
      fx.sim("systemctl", "--user", "start", "job-radar-ai-worker.service");
    }
    fx.inject({ noKill: true });
    const r = uninstall();
    expect(r.status).toBe(1);
    expect(fs.existsSync(def(L_DEFAULT))).toBe(true);
  }, SLOW);

  it("the release lock is held (a deploy or install is switching): exit 1, nothing called, the worker keeps running", () => {
    const pid = installed();
    fx.takeLock();
    const n = fx.changes().length;
    const r = uninstall();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the release lock exists");
    expect(r.stderr).toContain(fx.lockDir());
    expect(fx.changes().length).toBe(n);
    expect(fs.existsSync(def(L_DEFAULT))).toBe(true);
    expect(gone(pid)).toBe(false);
  }, SLOW);

  it("an unresolved switch backup: uninstalled anyway, the backup stays and is named, exit 0", () => {
    installed();
    fs.mkdirSync(fx.backupDir(), { recursive: true });
    fs.writeFileSync(path.join(fx.backupDir(), "state"), "found_label=x\n");
    const r = uninstall();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(def(L_DEFAULT))).toBe(false);
    expect(fs.existsSync(path.join(fx.backupDir(), "state"))).toBe(true);
    expect(`${r.stdout}${r.stderr}`).toContain(fx.backupDir());
  }, SLOW);
});
