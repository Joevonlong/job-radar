import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";

import { FakeInstall, type Manager } from "../helpers/fake-release";
import { createIsolatedDb, type IsolatedDb } from "../helpers/isolated-db";

/**
 * scripts/ops/install-ai-worker.sh switching the ai-worker between releases, against the service-manager simulator
 * (tests/ops/sim) and a fake worker (tests/fixtures/release/fake-worker.mjs) that takes the instance lock and writes
 * heartbeats in a database of its own. Nothing real is touched: every definition, release and lock lives in a mkdtemp
 * directory (tests/helpers/fake-release.ts), the simulator's processes are killed in afterEach, and the databases are
 * dropped in afterAll. The deploy timeouts are the smallest the scripts accept (stop 10 s, switch 20 s), so a case that
 * waits for a timeout costs 20–45 s.
 */
const L_DEFAULT = "io.jobradar.ai-worker";
const L_LEGACY = "de.jobradar.ai-worker";
const L_CUSTOM = "com.example.ai-worker";
const SLOW = 150_000;
const repoRoot = path.resolve(import.meta.dirname, "../..");

let iso: IsolatedDb;
let urlA: IsolatedDb;
let urlB: IsolatedDb;
const dropLater: IsolatedDb[] = [];
beforeAll(async () => {
  const server = inject("testDatabaseUrl");
  iso = await createIsolatedDb(server, "swap");
  urlA = await createIsolatedDb(server, "urla");
  urlB = await createIsolatedDb(server, "urlb");
}, 120_000);
afterAll(async () => {
  await iso?.drop();
  await urlA?.drop();
  await urlB?.drop();
  for (const db of dropLater) await db.drop();
});

const shaOf = (dir: string): string => path.basename(dir);

async function sessionsOn(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name like 'job-radar ai-worker%'`;
    return row?.n ?? 0;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

describe.each<Manager>(["systemd", "launchd"])("install-ai-worker.sh switch (%s)", (manager) => {
  let fx: FakeInstall;
  afterEach(async () => {
    await fx?.cleanup();
  });

  const target = (): string => (manager === "launchd" ? L_DEFAULT : "job-radar-ai-worker.service");
  const def = (label = L_DEFAULT): string => (manager === "launchd" ? fx.plist(label) : fx.unitFile());
  const install = (rel: string, extra: Record<string, string> = {}, url = iso.url) => fx.install(["--release", rel, "--database-url", url], { ...fx.tmpEnv(), ...extra });
  /** A first release installed and running (mode ok); returns its directory and pid. */
  function installed(opts: { label?: string } = {}): { rel: string; pid: number } {
    fx = new FakeInstall(manager);
    if (opts.label) fx.setDeploy({ label: opts.label });
    const rel = fx.release();
    const r = install(rel);
    expect(r.status, r.stderr).toBe(0);
    const pid = fx.servicePid(opts.label ?? L_DEFAULT);
    expect(pid).toBeGreaterThan(0);
    return { rel, pid };
  }
  const enabledState = (): string =>
    manager === "launchd" ? JSON.stringify(fx.state().launchd?.disabled ?? {}) : fx.sim("systemctl", "--user", "is-enabled", "job-radar-ai-worker.service").stdout.trim();

  it("installs a first release: absolute paths, release cwd, empty NODE_OPTIONS, enable before start, no backup, no lock", () => {
    fx = new FakeInstall(manager);
    const rel = fx.release();
    // launchd: a log an install from before data/logs/ left in launchd's capture directory
    const oldLog = path.join(fx.home, "Library/Logs/job-radar/ai-worker.err.log");
    if (manager === "launchd") {
      fs.mkdirSync(path.dirname(oldLog), { recursive: true });
      fs.writeFileSync(oldLog, "old line\n");
    }
    const r = install(rel);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`installed: ${target()} runs ${shaOf(rel)} from ${rel}`);
    if (manager === "launchd") {
      expect(fs.existsSync(oldLog)).toBe(false);
      expect(fs.readFileSync(path.join(fx.main, "data/logs/ai-worker.err.before-upgrade.log"), "utf8")).toBe("old line\n");
    }
    expect(fx.changes()).toEqual(manager === "launchd" ? [`enable gui/${process.getuid?.()}/${L_DEFAULT}`, `bootstrap gui/${process.getuid?.()} ${def()}`] : ["daemon-reload", "enable job-radar-ai-worker.service", "start job-radar-ai-worker.service"]);
    const [start] = fx.starts();
    expect(start?.cwd).toBe(rel);
    expect(start?.env).toMatchObject({
      NODE_OPTIONS: "",
      JOB_RADAR_DEFAULTS_DIR: path.join(rel, "config"),
      JOB_RADAR_CONFIG_DIR: path.join(fx.main, "data/config"),
      JOB_RADAR_PROFILE_DIR: path.join(fx.main, "data/profile"),
      JOB_RADAR_DATA_ROOT: fx.main,
      TSX_TSCONFIG_PATH: path.join(rel, "tsconfig.json"),
      DATABASE_URL: iso.url,
    });
    expect(start?.argv[1]).toBe(path.join(rel, "src/ai-worker/index.ts"));
    expect(start?.argv).toEqual(expect.arrayContaining(["--log-dir", path.join(fx.main, "data/logs")]));
    expect(start?.execArgv.join(" ")).toContain(`--env-file-if-exists=${path.join(fx.main, ".env")}`);
    // no guard in this release: no --import of release-guard.mjs; the tsx loader comes from the release
    expect(start?.execArgv.join(" ")).not.toContain("release-guard");
    expect(start?.execArgv.join(" ")).toContain(`file://${rel}/node_modules/tsx/`);
    expect(fs.existsSync(fx.backupDir())).toBe(false);
    expect(fs.existsSync(fx.lockDir())).toBe(false);
    expect(fx.tmpLeft()).toEqual([]);
    expect(fx.identity()).toMatchObject({ status: "0", found_definition: def() });
  }, SLOW);

  it("switches to a second release: the old pid is gone, the new one has evidence; old releases beyond keep are removed", () => {
    const { rel: r1, pid: p0 } = installed();
    fx.setDeploy({ keep: 2 });
    const old1 = fx.release({ created: "2020-01-01T00:00:00Z" });
    const old2 = fx.release({ created: "2020-01-02T00:00:00Z" });
    fs.symlinkSync(old2, path.join(fx.releasesDir(), "f".repeat(40)));
    const r2 = fx.release();
    const r = install(r2);
    expect(r.status, r.stderr).toBe(0);
    const p1 = fx.servicePid();
    expect(p1).toBeGreaterThan(0);
    expect(p1).not.toBe(p0);
    expect(fx.starts().at(-1)?.release).toBe(shaOf(r2));
    // keep 2: the new release and the previous one; the others go; a link is never followed or removed
    expect(fs.existsSync(r2) && fs.existsSync(r1)).toBe(true);
    expect(fs.existsSync(old1)).toBe(false);
    expect(fs.existsSync(old2)).toBe(false);
    expect(fs.lstatSync(path.join(fx.releasesDir(), "f".repeat(40))).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(fx.backupDir())).toBe(false);
  }, SLOW);

  it("case 1: the old worker does not stop: no new worker, the definition is back but not loaded, ROLLBACK FAILED, backup kept", () => {
    const { rel: r1, pid: p0 } = installed();
    fx.setModes({ [shaOf(r1)]: "ignore-term", default: "ok" });
    // the mode is read at start: restart the old worker under ignore-term
    if (manager === "launchd") {
      fx.sim("launchctl", "bootout", `gui/${process.getuid?.()}/${L_DEFAULT}`);
      fx.sim("launchctl", "bootstrap", `gui/${process.getuid?.()}`, def());
    } else {
      fx.sim("systemctl", "--user", "stop", "job-radar-ai-worker.service");
      fx.sim("systemctl", "--user", "start", "job-radar-ai-worker.service");
    }
    const old = fx.servicePid();
    expect(old).not.toBe(p0);
    fx.inject({ noKill: true });
    const r2 = fx.release();
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`ROLLBACK FAILED: install-ai-worker: original process ${old} survived`);
    expect(fx.starts().some((s) => s.release === shaOf(r2))).toBe(false);
    expect(fs.existsSync(def())).toBe(true);
    expect(fs.existsSync(path.join(fx.backupDir(), "state"))).toBe(true);
    expect(fs.existsSync(fx.lockDir())).toBe(false);
  }, SLOW);

  it("case 2 and 13: starting the new definition fails: the old worker is back with evidence, overrides as before, no clean-up", () => {
    const { rel: r1, pid: p0 } = installed();
    const stale = fx.release({ created: "2020-01-01T00:00:00Z" });
    fx.setDeploy({ keep: 2 });
    const before = enabledState();
    fx.inject({ failStarts: 1 });
    const r2 = fx.release();
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("rolled back: install-ai-worker: starting");
    expect(r.stderr).toContain(`the previous worker is back`);
    const pid = fx.servicePid();
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(p0);
    expect(fx.starts().at(-1)?.release).toBe(shaOf(r1));
    expect(enabledState()).toBe(before);
    expect(fs.existsSync(fx.backupDir())).toBe(false);
    expect(fs.existsSync(stale)).toBe(true); // 13: no clean-up after a failure
    expect(fs.readFileSync(def(), "utf8")).toContain(r1);
    expect(fx.tmpLeft()).toEqual([]);
  }, SLOW);

  it.each([["no-lock"], ["no-heartbeat"]] as const)("cases 3/4: the new worker is alive but %s: rolled back", (mode) => {
    const { rel: r1 } = installed();
    const r2 = fx.release();
    fx.setModes({ [shaOf(r2)]: mode, default: "ok" });
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("rolled back: install-ai-worker: the new worker did not show evidence");
    expect(fx.starts().at(-1)?.release).toBe(shaOf(r1));
    expect(fx.servicePid()).toBeGreaterThan(0);
    expect(fs.existsSync(fx.backupDir())).toBe(false);
  }, SLOW);

  it("case 5: the candidate does not stop: ROLLBACK FAILED, the old definition is not started", () => {
    installed();
    const r2 = fx.release();
    fx.setModes({ [shaOf(r2)]: "ignore-term-no-heartbeat", default: "ok" });
    fx.inject({ noKill: true });
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ROLLBACK FAILED: install-ai-worker: the new worker");
    expect(r.stderr).toContain("did not stop");
    expect(fx.starts().at(-1)?.release).toBe(shaOf(r2));
    expect(fs.existsSync(path.join(fx.backupDir(), "state"))).toBe(true);
  }, SLOW);

  it("case 6: the restored old definition does not come up: ROLLBACK FAILED, backup kept", () => {
    const { rel: r1 } = installed();
    const r2 = fx.release();
    fx.setModes({ [shaOf(r1)]: "crash", [shaOf(r2)]: "no-heartbeat" });
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ROLLBACK FAILED: install-ai-worker: the previous worker did not show evidence");
    expect(fs.existsSync(path.join(fx.backupDir(), "state"))).toBe(true);
  }, SLOW);

  it("case 7: stopped and disabled before: still stopped and disabled after a failed switch", () => {
    installed();
    if (manager === "launchd") {
      fx.sim("launchctl", "bootout", `gui/${process.getuid?.()}/${L_DEFAULT}`);
      fx.sim("launchctl", "disable", `gui/${process.getuid?.()}/${L_DEFAULT}`);
    } else {
      fx.sim("systemctl", "--user", "stop", "job-radar-ai-worker.service");
      fx.sim("systemctl", "--user", "disable", "job-radar-ai-worker.service");
    }
    const before = enabledState();
    const r2 = fx.release();
    fx.setModes({ [shaOf(r2)]: "no-heartbeat", default: "ok" });
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("rolled back:");
    expect(fx.servicePid()).toBe(0);
    expect(enabledState()).toBe(before);
    if (manager === "launchd") expect(fx.state().launchd?.loaded[L_DEFAULT]).toBeUndefined();
  }, SLOW);

  it("case 8 and 18: nothing installed before: a failed start leaves nothing (systemd: stop, disable, daemon-reload; no links)", () => {
    fx = new FakeInstall(manager);
    fx.inject({ failStarts: 1 });
    const r = install(fx.release());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no ai-worker was installed before, none is now");
    expect(fs.existsSync(def())).toBe(false);
    expect(fx.identity()).toMatchObject({ status: "0", origin: "none" });
    if (manager === "systemd") {
      expect(fx.changes().slice(-3)).toEqual(["stop job-radar-ai-worker.service", "disable job-radar-ai-worker.service", "daemon-reload"]);
      const wants = path.join(fx.xdg, "systemd/user/default.target.wants/job-radar-ai-worker.service");
      expect(() => fs.lstatSync(wants)).toThrow();
      expect(fx.sim("systemctl", "--user", "is-enabled", "job-radar-ai-worker.service").status).not.toBe(0);
    } else {
      expect(fx.state().launchd?.loaded[L_DEFAULT]).toBeUndefined();
    }
  }, SLOW);

  it("case 8, the enable state cannot be put back: ROLLBACK FAILED (not rolled back:), the backup is kept", () => {
    fx = new FakeInstall(manager);
    // launchd: the label was disabled before; the install enables it, and disabling it again fails. systemd: the unit
    // file goes in the rollback, so its enable state is the disable of step 2 of the rollback.
    if (manager === "launchd") fx.setLaunchdOverride(L_DEFAULT, true);
    fx.inject({ failStarts: 1, overrideFail: ["disable"] });
    const r = install(fx.release());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ROLLBACK FAILED: install-ai-worker:");
    expect(r.stderr).toContain(manager === "launchd" ? `cannot restore the enable state of ${L_DEFAULT}` : "systemctl --user disable job-radar-ai-worker.service failed");
    expect(r.stderr).not.toContain("rolled back:");
    expect(fs.existsSync(path.join(fx.backupDir(), "state"))).toBe(true);
    expect(fs.existsSync(fx.lockDir())).toBe(false);
  }, SLOW);

  it("a signal while the installed worker is stopping: the rollback waits for its pid, then brings it back (exit 143)", async () => {
    const { rel: r1 } = installed();
    fx.setModes({ [shaOf(r1)]: "slow-term", default: "ok" });
    if (manager === "launchd") {
      fx.sim("launchctl", "bootout", `gui/${process.getuid?.()}/${L_DEFAULT}`);
      fx.sim("launchctl", "bootstrap", `gui/${process.getuid?.()}`, def());
    } else {
      fx.sim("systemctl", "--user", "stop", "job-radar-ai-worker.service");
      fx.sim("systemctl", "--user", "start", "job-radar-ai-worker.service");
    }
    const old = fx.servicePid();
    expect(old).toBeGreaterThan(0);
    // the stop returns at once; the old worker needs 4 s to exit
    fx.inject({ asyncStop: true });
    const r2 = fx.release();
    const n = fx.changes().length;
    const run = fx.spawnInstall(["--release", r2, "--database-url", iso.url], fx.tmpEnv());
    const stopVerb = manager === "launchd" ? "bootout" : "stop";
    for (let i = 0; i < 300 && !fx.changes().slice(n).some((c) => c.startsWith(stopVerb)); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    process.kill(-(run.child.pid ?? 0), "SIGTERM");
    const res = await run.done;
    expect(res.code, res.out).toBe(143);
    expect(res.out).toContain(`interrupted (SIGTERM) while the installed worker (pid ${old}) was stopping`);
    expect(res.out).toContain("rolled back:");
    expect(res.out).not.toContain("ROLLBACK FAILED");
    expect(fx.starts().some((st) => st.release === shaOf(r2))).toBe(false);
    const back = fx.servicePid();
    expect(back).toBeGreaterThan(0);
    expect(back).not.toBe(old);
    expect(fx.starts().at(-1)?.release).toBe(shaOf(r1));
    expect(fs.existsSync(fx.backupDir())).toBe(false);
    expect(fs.existsSync(fx.lockDir())).toBe(false);
  }, SLOW);

  it("case 9: an unresolved backup refuses the switch (not changed:) without one service-manager call", () => {
    installed();
    fs.mkdirSync(fx.backupDir(), { recursive: true });
    const n = fx.changes().length;
    const r = install(fx.release());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not changed: install-ai-worker: an unresolved switch backup exists");
    expect(fx.changes().length).toBe(n);
  }, SLOW);

  it("case 12: an ambiguous identity refuses (not changed:), both definitions stay", () => {
    if (manager === "systemd") return; // one unit name: systemd cannot have two definitions
    installed({ label: L_LEGACY });
    fx.setDeploy({ label: L_CUSTOM });
    fs.copyFileSync(fx.plist(L_LEGACY), fx.plist(L_DEFAULT));
    const r = install(fx.release());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not changed: install-ai-worker: the ai-worker service identity is ambiguous");
    expect(fs.existsSync(fx.plist(L_LEGACY)) && fs.existsSync(fx.plist(L_DEFAULT))).toBe(true);
  }, SLOW);

  it("case 17: systemd masked: not changed:, nothing called", () => {
    if (manager === "launchd") return;
    installed();
    fx.inject({ masked: true });
    const n = fx.changes().length;
    const r = install(fx.release());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not changed: install-ai-worker: cannot record the enable state");
    expect(fx.changes().length).toBe(n);
  }, SLOW);

  it("case 19: systemd enabled before, the new unit fails: the unit and its link are back, enabled, with evidence", () => {
    if (manager === "launchd") return;
    const { rel: r1 } = installed();
    const r2 = fx.release();
    fx.setModes({ [shaOf(r2)]: "crash", default: "ok" });
    const r = install(r2);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("rolled back:");
    expect(fx.sim("systemctl", "--user", "is-enabled", "job-radar-ai-worker.service").stdout.trim()).toBe("enabled");
    expect(fs.readFileSync(fx.unitFile(), "utf8")).toContain(r1);
    expect(fx.servicePid()).toBeGreaterThan(0);
  }, SLOW);

  it("systemd: a unit still loaded after stop is stopped; a queued auto-restart is not (rolled back after the timeout)", () => {
    if (manager === "launchd") return;
    installed();
    const ok = install(fx.release());
    expect(ok.status, ok.stderr).toBe(0); // stop leaves LoadState=loaded: still a clean switch
    expect(fx.sim("systemctl", "--user", "show", "-p", "LoadState", "--value", "job-radar-ai-worker.service").stdout.trim()).toBe("loaded");
    fx.inject({ stuckAfterStop: true });
    const r3 = fx.release();
    const r = install(r3);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not stop within");
    expect(r.stderr).toMatch(/rolled back:|ROLLBACK FAILED:/);
    expect(fx.starts().some((s) => s.release === shaOf(r3))).toBe(false); // the new release never started
  }, SLOW);

  describe("launchd labels", () => {
    it.runIf(manager === "launchd")("cases 10/14: legacy label to L: on success the legacy file is gone; on failure back under the legacy label, running", () => {
      installed({ label: L_LEGACY });
      fx.setDeploy({ label: L_DEFAULT });
      const fail = fx.release();
      fx.setModes({ [shaOf(fail)]: "no-heartbeat", default: "ok" });
      const r = install(fail);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`rolled back:`);
      expect(r.stderr).toContain(`label ${L_LEGACY}`);
      expect(fs.existsSync(fx.plist(L_DEFAULT))).toBe(false);
      expect(fx.identity()).toMatchObject({ status: "0", found_label: L_LEGACY });
      expect(fx.servicePid(L_LEGACY)).toBeGreaterThan(0);
      const ok = install(fx.release());
      expect(ok.status, ok.stderr).toBe(0);
      expect(fs.existsSync(fx.plist(L_LEGACY))).toBe(false);
      expect(fx.servicePid(L_DEFAULT)).toBeGreaterThan(0);
      expect(fx.state().launchd?.loaded[L_LEGACY]).toBeUndefined();
    }, SLOW * 2);

    it.runIf(manager === "launchd")("case 11: default label to a custom one: failure keeps the default; success moves it", () => {
      installed();
      fx.setDeploy({ label: L_CUSTOM });
      fx.inject({ failStarts: 1 });
      const r = install(fx.release());
      expect(r.status).toBe(1);
      expect(fx.identity()).toMatchObject({ status: "0", found_label: L_DEFAULT });
      expect(fs.existsSync(fx.plist(L_CUSTOM))).toBe(false);
      const ok = install(fx.release());
      expect(ok.status, ok.stderr).toBe(0);
      expect(fs.existsSync(fx.plist(L_DEFAULT))).toBe(false);
      expect(fx.servicePid(L_CUSTOM)).toBeGreaterThan(0);
    }, SLOW);

    it.runIf(manager === "launchd")("case 15: both labels' overrides are restored (enabled / disabled / none)", () => {
      installed({ label: L_LEGACY });
      fx.setDeploy({ label: L_DEFAULT });
      fx.setLaunchdOverride(L_DEFAULT, true); // L disabled before: the install enables it first, the rollback disables it again
      fx.setLaunchdOverride(L_LEGACY, null);
      const before = JSON.stringify(fx.state().launchd?.disabled);
      fx.inject({ failStarts: 1 });
      const r = install(fx.release());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("rolled back:");
      // L had an override (disabled) and gets it back; the legacy label had none: the enable from its restart stays,
      // which launchd treats like none (header (f), step 7)
      const after = fx.state().launchd?.disabled ?? {};
      expect(after[L_DEFAULT]).toBe(true);
      expect(after[L_LEGACY] ?? false).toBe(false);
      expect(before).toContain(L_DEFAULT);
    }, SLOW);

    it.runIf(manager === "launchd")("case 16: disabled but running: back running with evidence, disabled again only after the evidence", () => {
      installed();
      fx.sim("launchctl", "disable", `gui/${process.getuid?.()}/${L_DEFAULT}`);
      const n = fx.changes().length;
      fx.inject({ failStarts: 1 });
      const r = install(fx.release());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("rolled back:");
      expect(fx.servicePid()).toBeGreaterThan(0);
      expect(fx.state().launchd?.disabled[L_DEFAULT]).toBe(true);
      const uid = process.getuid?.();
      expect(fx.changes().slice(n).slice(-3)).toEqual([`enable gui/${uid}/${L_DEFAULT}`, `bootstrap gui/${uid} ${def()}`, `disable gui/${uid}/${L_DEFAULT}`]);
    }, SLOW);
  });

  describe("database URL", () => {
    it(".env with only POSTGRES_*: the definition gets that URL and the switch succeeds on it", () => {
      fx = new FakeInstall(manager);
      const u = new URL(urlA.url);
      fx.writeEnv({ POSTGRES_USER: decodeURIComponent(u.username), POSTGRES_PASSWORD: decodeURIComponent(u.password), POSTGRES_DB: u.pathname.slice(1), DB_HOST_PORT: u.port });
      const r = fx.install(["--release", fx.release()], fx.tmpEnv());
      expect(r.status, r.stderr).toBe(0);
      expect(fx.starts().at(-1)?.env.DATABASE_URL).toBe(`postgres://${u.username}:${u.password}@127.0.0.1:${u.port}${u.pathname}`);
    }, SLOW);

    it("--database-url A wins over .env DATABASE_URL B: evidence on A, B never sees a worker", async () => {
      fx = new FakeInstall(manager);
      fx.writeEnv({ DATABASE_URL: urlB.url });
      const r = fx.install(["--release", fx.release(), "--database-url", urlA.url], fx.tmpEnv());
      expect(r.status, r.stderr).toBe(0);
      expect(fx.starts().at(-1)?.env.DATABASE_URL).toBe(urlA.url);
      expect(await sessionsOn(urlA.url)).toBeGreaterThan(0);
      expect(await sessionsOn(urlB.url)).toBe(0);
    }, SLOW);

    it("rollback probes with the installed definition's URL, not this run's", () => {
      fx = new FakeInstall(manager);
      const r1 = fx.release();
      expect(install(r1, {}, urlA.url).status).toBe(0);
      fx.inject({ failStarts: 1 });
      const r = install(fx.release(), {}, urlB.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("rolled back:");
      expect(r.stderr).toContain("the previous worker is back");
      expect(fx.starts().at(-1)?.env.DATABASE_URL).toBe(urlA.url);
    }, SLOW);

    it.runIf(manager === "systemd")("a password with % \\ \" (percent-encoded): installs, and a failed switch rolls back with the decoded URL", async () => {
      fx = new FakeInstall(manager);
      // a database of its own whose owner gets the password (the owner already has every right the worker needs)
      const own = await createIsolatedDb(inject("testDatabaseUrl"), "swap");
      dropLater.push(own);
      const role = new URL(own.url);
      const admin = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`alter role "${decodeURIComponent(role.username)}" password 'p%w\\d"x'`);
      } finally {
        await admin.end({ timeout: 2 });
      }
      role.password = "p%25w%5Cd%22x";
      const url = role.toString();
      const ok = install(fx.release(), {}, url);
      expect(ok.status, ok.stderr).toBe(0);
      expect(fs.readFileSync(fx.unitFile(), "utf8")).toContain("%%25");
      fx.inject({ failStarts: 1 });
      const r = install(fx.release(), {}, url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("rolled back:");
      expect(r.stderr).not.toContain("ROLLBACK FAILED");
      expect(fx.starts().at(-1)?.env.DATABASE_URL).toBe(url);
    }, SLOW);

    it.runIf(manager === "systemd")("an unsupported Environment= line in the installed unit: not changed: before any stop", () => {
      installed();
      const unit = fs.readFileSync(fx.unitFile(), "utf8").replace(/^Environment="DATABASE_URL=(.*)"$/m, 'Environment="DATABASE_URL=$1\\x41"');
      fs.writeFileSync(fx.unitFile(), unit);
      const pid = fx.servicePid();
      const n = fx.changes().length;
      const r = install(fx.release());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not changed: install-ai-worker: cannot read the database URL of the installed definition");
      expect(fx.changes().length).toBe(n);
      expect(fx.servicePid()).toBe(pid);
    }, SLOW);
  });

  describe("lock and exit handling", () => {
    const noRecord = (): void => expect(Object.values(fx.inflight()).filter((t) => t.includes("script=install-ai-worker"))).toEqual([]);

    it("with an inherited token: success, not changed:, rolled back: all leave no record of the install script and no temp file", () => {
      installed();
      const token = fx.takeLock();
      const env = { ...fx.tmpEnv(), JOB_RADAR_RELEASES_LOCK_TOKEN: token };
      const first = fx.install(["--release", fx.release(), "--database-url", iso.url], env);
      expect(first.status, first.stderr).toBe(0);
      noRecord();
      expect(fx.install(["--release", path.join(fx.releasesDir(), "0".repeat(40)), "--database-url", iso.url], env).stderr).toContain("not changed:");
      noRecord();
      fx.inject({ failStarts: 1 });
      expect(fx.install(["--release", fx.release(), "--database-url", iso.url], env).stderr).toContain("rolled back:");
      noRecord();
      expect(fs.existsSync(path.join(fx.lockDir(), "owner"))).toBe(true); // the holder's lock is not released by the install
      expect(fx.tmpLeft()).toEqual([]);
    }, SLOW * 2);

    it.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("%s while waiting for evidence: rolled back, exit %i, the lock goes only after the last service-manager call", async (sig, code) => {
      const { rel: r1 } = installed();
      const r2 = fx.release();
      fx.setModes({ [shaOf(r2)]: "no-heartbeat", default: "ok" });
      const run = fx.spawnInstall(["--release", r2, "--database-url", iso.url], fx.tmpEnv());
      let lockGoneAt = 0;
      for (let i = 0; i < 300 && !fx.starts().some((s) => s.release === shaOf(r2)); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1000));
      process.kill(-(run.child.pid ?? 0), sig);
      const poll = setInterval(() => {
        if (!lockGoneAt && !fs.existsSync(fx.lockDir())) lockGoneAt = Date.now();
      }, 20);
      // a second signal in the middle of the rollback changes nothing
      await new Promise((r) => setTimeout(r, 300));
      try {
        process.kill(-(run.child.pid ?? 0), sig);
      } catch {
        /* already done */
      }
      const res = await run.done;
      clearInterval(poll);
      if (!lockGoneAt) lockGoneAt = Date.now();
      expect(res.code, res.out).toBe(code);
      expect(res.out).toContain("rolled back:");
      expect(fx.starts().at(-1)?.release).toBe(shaOf(r1));
      expect(Math.max(...fx.calls().map((c) => c.t))).toBeLessThanOrEqual(lockGoneAt);
      expect(fs.existsSync(fx.lockDir())).toBe(false);
      expect(fx.tmpLeft()).toEqual([]);
    }, SLOW);

    it("the real deploy.sh gets SIGHUP while its real install waits for evidence: one TERM to the install, rolled back, exit 129; the lock goes only after the last service-manager call", async () => {
      const { rel: r1 } = installed();
      const r2 = fx.release(); // HEAD of the fake main checkout, with its release ready (prepare-release.sh reuses it)
      fx.setModes({ [shaOf(r2)]: "no-heartbeat", default: "ok" });
      // the main checkout runs this repository's scripts (deploy.sh, prepare-release.sh, install-ai-worker.sh); the
      // install reads DATABASE_URL from .env (deploy.sh passes no --database-url); docker and pnpm are stubs
      fs.symlinkSync(path.join(repoRoot, "scripts"), path.join(fx.main, "scripts"));
      fx.writeEnv({ DATABASE_URL: iso.url });
      const stubs = path.join(fx.tmp, "deploy-stubs");
      fs.mkdirSync(stubs, { recursive: true });
      const log = path.join(fx.tmp, "deploy-stubs.log");
      for (const tool of ["docker", "pnpm"]) fs.writeFileSync(path.join(stubs, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
      const env = { ...fx.tmpEnv(), PATH: `${stubs}:${fx.env().PATH ?? ""}` };
      const child = spawn("bash", [path.join(fx.main, "scripts/ops/deploy.sh"), "--skip-pull", "--no-backup", "--no-prune", "--no-drain", "--settle", "0"], {
        cwd: fx.main,
        env: fx.env(env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
      const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      for (let i = 0; i < 600 && !fx.starts().some((st) => st.release === shaOf(r2)); i++) await new Promise((r) => setTimeout(r, 100));
      expect(fx.starts().some((st) => st.release === shaOf(r2)), out).toBe(true);
      await new Promise((r) => setTimeout(r, 1000));
      let lockGoneAt = 0;
      const poll = setInterval(() => {
        if (!lockGoneAt && !fs.existsSync(fx.lockDir())) lockGoneAt = Date.now();
      }, 20);
      process.kill(-(child.pid ?? 0), "SIGHUP");
      await new Promise((r) => setTimeout(r, 300));
      try {
        process.kill(-(child.pid ?? 0), "SIGHUP"); // a second one is only recorded
      } catch {
        /* already done */
      }
      const code = await done;
      clearInterval(poll);
      if (!lockGoneAt) lockGoneAt = Date.now();
      expect(code, out).toBe(129);
      expect(out).toContain("interrupted (SIGTERM) while waiting for the new worker");
      expect(out).toContain("rolled back:");
      expect(out).not.toContain("ROLLBACK FAILED");
      expect(fx.starts().at(-1)?.release).toBe(shaOf(r1));
      expect(fx.servicePid()).toBeGreaterThan(0);
      expect(Math.max(...fx.calls().map((c) => c.t))).toBeLessThanOrEqual(lockGoneAt);
      expect(fs.existsSync(fx.lockDir())).toBe(false);
      expect(fs.existsSync(fx.backupDir())).toBe(false);
      const stubCalls = fs.readFileSync(log, "utf8");
      expect(stubCalls).not.toContain("pnpm run doctor");
      expect(stubCalls).not.toContain("prune");
    }, SLOW);
  });
});

describe("install-ai-worker.sh without --release (prepare under the same lock)", () => {
  let fx: FakeInstall;
  let bin = "";
  afterEach(async () => {
    if (bin) fs.writeFileSync(path.join(fx.tmp, "continue"), "");
    await fx?.cleanup();
  });

  /** A main checkout whose HEAD is a release-shaped commit, and a pnpm stub that "installs" by linking tsx. */
  function head(block = false): Record<string, string> {
    fx = new FakeInstall("systemd");
    const repo = path.resolve(import.meta.dirname, "../..");
    fs.mkdirSync(path.join(fx.main, "src/ai-worker"), { recursive: true });
    fs.writeFileSync(path.join(fx.main, "src/ai-worker/index.ts"), `import ${JSON.stringify(`file://${path.join(repo, "tests/fixtures/release/fake-worker.mjs")}`)};\n`);
    fs.writeFileSync(path.join(fx.main, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(fx.main, "package.json"), `${JSON.stringify({ name: "fake-main", type: "module", packageManager: "pnpm@9.8.7" }, null, 2)}\n`);
    fx.commit("head release");
    bin = path.join(fx.tmp, "bin");
    fs.mkdirSync(bin);
    const tsx = fs.realpathSync(path.join(repo, "node_modules/tsx"));
    fs.writeFileSync(
      path.join(bin, "pnpm"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo 9.8.7; exit 0; fi
[[ "\${1:-}" == install ]] || exit 0
mkdir -p node_modules/.pnpm/dep && echo x > node_modules/.pnpm/dep/f.js && ln -s ${JSON.stringify(tsx)} node_modules/tsx
echo "pnpm install pgid=$(ps -o pgid= -p $$ | tr -d ' ') ppid=$PPID lock=$(ls ${JSON.stringify(fx.lockDir())}/inflight | tr '\\n' ' ')" >> ${JSON.stringify(path.join(fx.tmp, "pnpm.log"))}
${block ? `while [[ ! -e ${JSON.stringify(path.join(fx.tmp, "continue"))} ]]; do sleep 0.05; done` : ""}
exit 0
`,
      { mode: 0o755 },
    );
    return { ...fx.tmpEnv(), PATH: `${bin}:${fx.env().PATH ?? ""}` };
  }
  const pnpmLog = (): string => (fs.existsSync(path.join(fx.tmp, "pnpm.log")) ? fs.readFileSync(path.join(fx.tmp, "pnpm.log"), "utf8") : "");

  it("prepares HEAD under the install script's own lock (not blocked by itself), then installs it", () => {
    const env = head();
    const r = fx.install(["--database-url", iso.url], env);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(pnpmLog()).toContain("pnpm install");
    // both the install script and prepare-release were registered while pnpm ran
    expect(pnpmLog().match(/lock=(.*)$/m)?.[1]?.trim().split(" ").length).toBe(2);
    expect(fx.starts().at(-1)?.release).toBe(fx.git("rev-parse", "HEAD"));
    expect(fs.existsSync(fx.lockDir())).toBe(false);
  }, SLOW);

  async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 600 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(cond()).toBe(true);
  }

  it("prepare killed with -9: exit 1 (not 3), not changed:, descendant exit not confirmed, the lock and prepare's record stay", async () => {
    const env = head(true);
    const run = fx.spawnInstall(["--database-url", iso.url], env);
    await waitFor(() => pnpmLog().includes("pnpm install"));
    const preparePid = Number(Object.entries(fx.inflight()).find(([, t]) => t.includes("script=prepare-release"))?.[0]);
    expect(preparePid).toBeGreaterThan(0);
    process.kill(preparePid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(path.join(fx.tmp, "continue"), "");
    const res = await run.done;
    expect(res.code, res.out).toBe(1);
    expect(res.out).toContain("not changed:");
    expect(res.out).toContain("descendant exit not confirmed");
    expect(Object.values(fx.inflight()).some((t) => t.includes("script=prepare-release"))).toBe(true);
    expect(fx.starts()).toEqual([]);
  }, SLOW);

  it("TERM to the install script while prepare runs: prepare finishes, nothing is switched, exit 143", async () => {
    const env = head(true);
    const run = fx.spawnInstall(["--database-url", iso.url], env);
    await waitFor(() => pnpmLog().includes("pnpm install"));
    process.kill(run.child.pid ?? 0, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(fx.tmp, "continue"), "");
    const res = await run.done;
    expect(res.code, res.out).toBe(143);
    expect(res.out).toContain("not changed:");
    expect(fx.starts()).toEqual([]);
    expect(fs.existsSync(fx.lockDir())).toBe(false);
  }, SLOW);
});
