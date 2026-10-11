// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/install-ai-worker.sh --dry-run: the plist it would write, against a throw-away checkout and home
 * directory. A dry run neither writes nor loads anything, so no launchd agent is touched.
 */
const script = path.resolve(import.meta.dirname, "../../scripts/ops/install-ai-worker.sh");
const uninstall = path.resolve(import.meta.dirname, "../../scripts/ops/uninstall-ai-worker.sh");

let tmp = "";
let root = "";
let home = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-ai-worker-"));
  root = path.join(tmp, "checkout");
  home = path.join(tmp, "home");
  for (const file of ["package.json", "src/ai-worker/index.ts", "node_modules/tsx/dist/loader.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  fs.mkdirSync(path.join(home, "Library/Logs/job-radar"), { recursive: true });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dryRun = () =>
  spawnSync("bash", [script, "--dry-run", "--root", root, "--database-url", "postgres://u:secret@127.0.0.1:5433/db"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

describe.skipIf(process.platform !== "darwin")("scripts/ops/install-ai-worker.sh --dry-run", () => {
  it("passes bash -n, and so does the uninstall script", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
    expect(spawnSync("bash", ["-n", uninstall]).status).toBe(0);
  });

  it("starts the worker itself (node --import tsx), not through the tsx CLI parent, and gives launchd an exit timeout", () => {
    const r = dryRun();
    expect(r.status).toBe(0);
    const loader = `file://${path.join(fs.realpathSync(root), "node_modules/tsx/dist/loader.mjs")}`;
    expect(r.stdout).toContain(`<string>--import</string>\n    <string>${loader}</string>`);
    expect(r.stdout).not.toContain("cli.mjs");
    expect(r.stdout).toMatch(/<key>ExitTimeOut<\/key>\n {2}<integer>60<\/integer>/);
  });

  it("has the worker write its logs on the checkout's volume and launchd only its small capture file", () => {
    const r = dryRun();
    expect(r.status).toBe(0);
    const logDir = path.join(fs.realpathSync(root), "data/logs");
    const launchdLog = path.join(home, "Library/Logs/job-radar/ai-worker.launchd.log");
    expect(r.stdout).toContain(`<string>--log-dir</string>\n    <string>${logDir}</string>`);
    expect(r.stdout).toContain(`<string>--launchd-log</string>\n    <string>${launchdLog}</string>`);
    expect(r.stdout).toContain(`<key>StandardOutPath</key>\n  <string>${launchdLog}</string>`);
    expect(r.stdout).toContain(`<key>StandardErrorPath</key>\n  <string>${launchdLog}</string>`);
    // launchd cannot open files on an external volume (EX_CONFIG): its capture paths must never point there
    expect(r.stdout).not.toMatch(/<key>Standard(Out|Error)Path<\/key>\n {2}<string>\/Volumes\//);
    expect(r.stdout).not.toContain(`<string>${logDir}/ai-worker.out.log</string>`);
    expect(r.stdout).not.toContain("secret");
    expect(fs.existsSync(logDir)).toBe(false); // a dry run creates nothing
  });

  it("gives the worker the three config directories of the checkout explicitly", () => {
    const r = dryRun();
    expect(r.status).toBe(0);
    const app = fs.realpathSync(root);
    expect(r.stdout).toContain(`<key>JOB_RADAR_DEFAULTS_DIR</key>\n    <string>${app}/config</string>`);
    expect(r.stdout).toContain(`<key>JOB_RADAR_CONFIG_DIR</key>\n    <string>${app}/data/config</string>`);
    expect(r.stdout).toContain(`<key>JOB_RADAR_PROFILE_DIR</key>\n    <string>${app}/data/profile</string>`);
  });

  it("plans to move the logs of an earlier install once, and has nothing to move without them", () => {
    expect(dryRun().stdout).not.toContain("move the old log");
    fs.writeFileSync(path.join(home, "Library/Logs/job-radar/ai-worker.err.log"), "old\n");
    const r = dryRun();
    expect(r.stdout).toContain(`cat ${path.join(home, "Library/Logs/job-radar/ai-worker.err.log")} >> ${path.join(fs.realpathSync(root), "data/logs/ai-worker.err.before-upgrade.log")}`);
    expect(r.stdout).not.toContain("ai-worker.out.before-upgrade.log");
    expect(fs.readFileSync(path.join(home, "Library/Logs/job-radar/ai-worker.err.log"), "utf8")).toBe("old\n");
  });

  it("installs under the io.jobradar label and plans to remove an agent with the old de.jobradar label", () => {
    const legacyPlist = path.join(home, "Library/LaunchAgents/de.jobradar.ai-worker.plist");
    const r = dryRun();
    expect(r.stdout).toContain("<string>io.jobradar.ai-worker</string>");
    expect(r.stdout).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${path.join(home, "Library/LaunchAgents/io.jobradar.ai-worker.plist")}`);
    fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
    fs.writeFileSync(legacyPlist, "<plist/>");
    try {
      const migrating = dryRun();
      expect(migrating.status).toBe(0);
      expect(migrating.stdout).toContain(`launchctl bootout gui/${process.getuid?.()}/de.jobradar.ai-worker && rm ${legacyPlist}`);
      expect(fs.existsSync(legacyPlist)).toBe(true); // a dry run removes nothing
    } finally {
      fs.rmSync(legacyPlist);
    }
  });

  it("rolls back to the old agent when bootstrapping the new one fails (stub launchctl)", () => {
    const bin = path.join(tmp, "stubbin");
    const calls = path.join(tmp, "launchctl.calls");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(calls, "");
    // `print` of the old label succeeds until it is booted out, the new label is never loaded, bootstrap of the new plist fails
    fs.writeFileSync(
      path.join(bin, "launchctl"),
      `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$1" in
  print) [[ "$2" == */de.jobradar.ai-worker ]] && ! grep -q "^bootout .*de.jobradar" "${calls}"; exit $? ;;
  bootstrap) [[ "$3" == *io.jobradar* ]] && exit 5; exit 0 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const legacyPlist = path.join(home, "Library/LaunchAgents/de.jobradar.ai-worker.plist");
    fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
    fs.writeFileSync(legacyPlist, "<plist/>");
    try {
      const r = spawnSync("bash", [script, "--root", root, "--database-url", "postgres://u:p@127.0.0.1:5433/db"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("bootstrap of io.jobradar.ai-worker failed");
      expect(r.stderr).toContain("rolled back");
      expect(fs.existsSync(legacyPlist)).toBe(true); // the old plist is kept
      expect(fs.existsSync(path.join(home, "Library/LaunchAgents/io.jobradar.ai-worker.plist"))).toBe(false);
      const log = fs.readFileSync(calls, "utf8");
      expect(log.indexOf("bootout")).toBeLessThan(log.indexOf("bootstrap"));
      expect(log).toContain(`bootstrap gui/${process.getuid?.()} ${legacyPlist}`);
    } finally {
      fs.rmSync(legacyPlist, { force: true });
    }
  });

  it("still accepts --root naming a workspace checkout that holds the product in job-radar/", () => {
    const ws = path.join(tmp, "workspace");
    fs.mkdirSync(path.join(ws, "job-radar"), { recursive: true });
    fs.cpSync(root, path.join(ws, "job-radar"), { recursive: true });
    const r = spawnSync("bash", [script, "--dry-run", "--root", ws, "--database-url", "postgres://u:p@127.0.0.1:5433/db"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(path.join(fs.realpathSync(ws), "job-radar/data/logs"));
  });

  it("without --root, starts the agent from the product directory the script belongs to", () => {
    const product = path.join(tmp, "own-repo");
    fs.cpSync(root, product, { recursive: true });
    fs.mkdirSync(path.join(product, "scripts/ops"), { recursive: true });
    fs.copyFileSync(script, path.join(product, "scripts/ops/install-ai-worker.sh"));
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: product, encoding: "utf8" });
    git("init", "-q");
    const r = spawnSync("bash", [path.join(product, "scripts/ops/install-ai-worker.sh"), "--dry-run", "--database-url", "postgres://u:p@127.0.0.1:5433/db"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`<string>${path.join(fs.realpathSync(product), "data/logs")}</string>`);
  });
});

/** Linux: the systemd user unit (forced with JOB_RADAR_SERVICE_MANAGER, so it runs on any platform; a dry run touches nothing). */
describe("scripts/ops/install-ai-worker.sh --dry-run with systemd", () => {
  const systemdDryRun = (checkout: string, databaseUrl: string) =>
    spawnSync("bash", [script, "--dry-run", "--root", checkout, "--database-url", databaseUrl], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, JOB_RADAR_SERVICE_MANAGER: "systemd" },
    });

  it("renders the job-radar-ai-worker.service user unit and writes nothing", () => {
    const r = systemdDryRun(root, "postgres://u:secret@127.0.0.1:5433/db");
    expect(r.status).toBe(0);
    const real = fs.realpathSync(root);
    expect(r.stdout).toContain(`${path.join(home, ".config/systemd/user/job-radar-ai-worker.service")}`);
    expect(r.stdout).toContain(`WorkingDirectory=${real}\n`);
    expect(r.stdout).toMatch(/ExecStart="[^"]*node" --import "file:\/\/[^"]*\/node_modules\/tsx\/dist\/loader\.mjs" --env-file-if-exists=\.env src\/ai-worker\/index\.ts --log-dir "[^"]*\/data\/logs"/);
    expect(r.stdout).toContain(`Environment="JOB_RADAR_CONFIG_DIR=${real}/data/config"`);
    expect(r.stdout).toContain("Restart=always");
    expect(r.stdout).toContain("WantedBy=default.target");
    expect(r.stdout).toContain("systemctl --user enable job-radar-ai-worker.service");
    // the database password never reaches the output
    expect(r.stdout).not.toContain("secret");
    expect(r.stdout).not.toContain("@APP_DIR@");
    expect(fs.existsSync(path.join(home, ".config/systemd"))).toBe(false);
  });

  it("escapes values per setting: % everywhere, quotes and backslashes inside quotes, $ only in ExecStart", () => {
    const odd = path.join(tmp, 'check out%1 "q" $HOME');
    fs.cpSync(root, odd, { recursive: true });
    const r = systemdDryRun(odd, "postgres://u:secret@127.0.0.1:5433/d$b%x");
    expect(r.status).toBe(0);
    const real = fs.realpathSync(odd);
    const esc = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
    expect(r.stdout).toContain(`WorkingDirectory=${real.replaceAll("%", "%%")}\n`);
    expect(r.stdout).toContain(`--log-dir "${esc(path.join(real, "data/logs")).replaceAll("$", () => "$$")}"`);
    expect(r.stdout).toContain(`Environment="JOB_RADAR_PROFILE_DIR=${esc(path.join(real, "data/profile"))}"`);
    expect(r.stdout).toContain('Environment="DATABASE_URL=postgres://u:***@127.0.0.1:5433/d$b%%x"');
  });
});

/** No reachable systemd user manager on "Linux" (stub uname / systemctl first on PATH): say why, touch nothing. */
describe("the scripts without a reachable systemd user manager", () => {
  let stubs = "";
  let linuxHome = "";
  beforeAll(() => {
    stubs = fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-stubs-"));
    linuxHome = path.join(stubs, "home");
    fs.mkdirSync(linuxHome);
    fs.writeFileSync(path.join(stubs, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(stubs, { recursive: true, force: true }));

  const run = (file: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync("bash", [file, ...args], { encoding: "utf8", env: { NODE_ENV: "test", PATH: `${stubs}:/usr/bin:/bin`, HOME: linuxHome, ...extra } });
  const unitFile = () => path.join(linuxHome, ".config/systemd/user/job-radar-ai-worker.service");

  it("install explains a missing XDG_RUNTIME_DIR, or suggests enable-linger, and installs nothing", () => {
    const noRuntime = run(script, ["--root", root]);
    expect(noRuntime.status).toBe(0);
    expect(noRuntime.stdout).toContain("XDG_RUNTIME_DIR is not set");
    const linger = run(script, ["--root", root], { XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(linger.status).toBe(0);
    expect(linger.stdout).toContain("loginctl enable-linger");
    expect(fs.existsSync(path.join(linuxHome, ".config"))).toBe(false);
  });

  it("uninstall: nothing installed is fine; a unit file it cannot stop is kept, with the reason", () => {
    const none = run(uninstall, []);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("no job-radar-ai-worker.service installed");
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), "[Unit]\n");
    const stuck = run(uninstall, [], { XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("loginctl enable-linger");
    expect(fs.existsSync(unitFile())).toBe(true);
  });
});
