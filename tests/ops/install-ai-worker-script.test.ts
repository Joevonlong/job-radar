// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/install-ai-worker.sh without a database or a service manager: its arguments, the paths of the definition
 * it would write (--dry-run, with the manager forced through JOB_RADAR_SERVICE_MANAGER, so both run on any platform),
 * --print-release, and static checks. Everything is under a throw-away main checkout and home directory; a dry run
 * neither writes nor loads anything. The switch itself (simulator, fake worker, database) is in
 * tests/integration/ai-worker-swap.test.ts.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "scripts/ops/install-ai-worker.sh");
const uninstall = path.join(repo, "scripts/ops/uninstall-ai-worker.sh");
const aiWorkerLib = path.join(repo, "scripts/ops/lib/ai-worker.sh");
const plutilShim = path.join(repo, "tests/ops/sim/plutil-shim");
const SHA = "a".repeat(40);

let tmp = "";
let root = "";
let home = "";
let xdg = "";
let release = "";

function makeRelease(main: string, sha: string, opts: { guard?: boolean } = {}): string {
  const dir = path.join(main, "data/releases/ai-worker", sha);
  for (const file of ["src/ai-worker/index.ts", "node_modules/tsx/dist/loader.mjs", "package.json", "tsconfig.json", ...(opts.guard ? ["src/ai-worker/release-guard.mjs"] : [])]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "");
  }
  return dir;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-ai-worker-")));
  root = path.join(tmp, "checkout");
  home = path.join(tmp, "home");
  xdg = path.join(tmp, "xdg");
  fs.mkdirSync(path.join(root, "data/config"), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "data/config/schedule.yaml"), "deploy:\n  ai_worker_stop_timeout_seconds: 15\n  ai_worker_swap_timeout_seconds: 30\n");
  release = makeRelease(root, SHA);
});

afterAll(() => {
  if (tmp && path.basename(tmp).startsWith("install-ai-worker-")) fs.rmSync(tmp, { recursive: true, force: true });
});

function env(manager: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, JOB_RADAR_SERVICE_MANAGER: manager, ...extra };
  delete e.DATABASE_URL;
  delete e.JOB_RADAR_RELEASES_LOCK_TOKEN;
  return e;
}
const dryRun = (manager: string, args: string[] = ["--release", release], url = "postgres://u:secret@127.0.0.1:5433/db", main = root) =>
  spawnSync("bash", [script, "--dry-run", "--root", main, "--database-url", url, ...args], { encoding: "utf8", env: env(manager) });

describe("static checks", () => {
  it("passes bash -n, and so does the uninstall script", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
    expect(spawnSync("bash", ["-n", uninstall]).status).toBe(0);
  });

  it("carries the capability line deploy.sh --ref looks for, as a whole line", () => {
    expect(fs.readFileSync(script, "utf8").split("\n")).toContain("# capability: ai-worker-release-dir");
  });

  it("sets traps only through proc_traps (no trap … EXIT of its own) in deploy.sh, prepare-release.sh and the install script", () => {
    for (const name of ["deploy.sh", "prepare-release.sh", "install-ai-worker.sh"]) {
      const lines = fs
        .readFileSync(path.join(repo, "scripts/ops", name), "utf8")
        .split("\n")
        .filter((l) => /(^|[^a-z_])(proc_)?traps?\b/.test(l) && !/^\s*#/.test(l));
      expect(lines.map((l) => l.trim()), name).toEqual(["proc_traps on_exit"]);
    }
  });
});

describe.each(["launchd", "systemd"])("--dry-run (%s)", (manager) => {
  it("runs the release's code with absolute paths and the user's data from the main checkout; writes nothing, takes no lock", () => {
    const r = dryRun(manager);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    if (manager === "launchd") {
      expect(out).toContain(`<key>WorkingDirectory</key>\n  <string>${release}</string>`);
      expect(out).toContain(`<string>file://${release}/node_modules/tsx/dist/loader.mjs</string>`);
      expect(out).toContain(`<string>${release}/src/ai-worker/index.ts</string>`);
      expect(out).toContain(`<string>--env-file-if-exists=${root}/.env</string>`);
      expect(out).toContain(`<key>NODE_OPTIONS</key>\n    <string></string>`);
      expect(out).toContain(`<key>JOB_RADAR_DEFAULTS_DIR</key>\n    <string>${release}/config</string>`);
      expect(out).toContain(`<key>JOB_RADAR_CONFIG_DIR</key>\n    <string>${root}/data/config</string>`);
      expect(out).toContain(`<key>JOB_RADAR_DATA_ROOT</key>\n    <string>${root}</string>`);
      expect(out).toContain(`<key>TSX_TSCONFIG_PATH</key>\n    <string>${release}/tsconfig.json</string>`);
      expect(out).toMatch(/<key>ExitTimeOut<\/key>\n {2}<integer>15<\/integer>/);
      // launchd cannot open files on an external volume: its capture file stays under HOME
      expect(out).toContain(`<key>StandardOutPath</key>\n  <string>${home}/Library/Logs/job-radar/ai-worker.launchd.log</string>`);
    } else {
      expect(out).toContain(`WorkingDirectory=${release}\n`);
      expect(out).toMatch(new RegExp(`ExecStart="[^"]*node" --import "file://${release}/node_modules/tsx/dist/loader\\.mjs" "--env-file-if-exists=${root}/\\.env" "${release}/src/ai-worker/index\\.ts" --log-dir "${root}/data/logs"`));
      expect(out).toContain('Environment="NODE_OPTIONS="');
      expect(out).toContain(`Environment="JOB_RADAR_DEFAULTS_DIR=${release}/config"`);
      expect(out).toContain(`Environment="JOB_RADAR_PROFILE_DIR=${root}/data/profile"`);
      expect(out).toContain(`Environment="JOB_RADAR_DATA_ROOT=${root}"`);
      expect(out).toContain(`Environment="TSX_TSCONFIG_PATH=${release}/tsconfig.json"`);
      expect(out).toContain("TimeoutStopSec=15");
      expect(out).toContain(path.join(xdg, "systemd/user/job-radar-ai-worker.service"));
      expect(out).not.toMatch(/@[A-Z_]+@/);
    }
    expect(out).toContain("timeouts:  stop 15 s, switch 30 s");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("release-guard"); // this release has no guard
    expect(fs.existsSync(path.join(root, "data/releases/ai-worker/.lock"))).toBe(false);
    expect(fs.existsSync(path.join(root, "data/logs"))).toBe(false);
    expect(fs.existsSync(path.join(xdg, "systemd"))).toBe(false);
  });

  it("imports the release's guard first, only when the release has one", () => {
    const sha = "b".repeat(40);
    const withGuard = makeRelease(root, sha, { guard: true });
    const r = dryRun(manager, ["--release", withGuard]);
    expect(r.status, r.stderr).toBe(0);
    const guard = `file://${withGuard}/src/ai-worker/release-guard.mjs`;
    const loader = `file://${withGuard}/node_modules/tsx/dist/loader.mjs`;
    expect(r.stdout.indexOf(guard)).toBeGreaterThan(0);
    expect(r.stdout.indexOf(guard)).toBeLessThan(r.stdout.indexOf(loader));
    const command = manager === "launchd" ? r.stdout : (r.stdout.split("\n").find((l) => l.startsWith("ExecStart=")) ?? "");
    expect(command.match(/--import/g)?.length).toBe(2);
  });

  it("makes a relative --release absolute; refuses a link, or a directory that is not <main>/data/releases/ai-worker/<sha>", () => {
    const rel = spawnSync("bash", [script, "--dry-run", "--root", root, "--database-url", "postgres://u@h/d", "--release", `data/releases/ai-worker/${SHA}`], { encoding: "utf8", env: env(manager), cwd: root });
    expect(rel.status, rel.stderr).toBe(0);
    expect(rel.stdout).toContain(`release:   ${release}`);
    const link = path.join(tmp, "link-to-release");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(release, link);
    const linked = dryRun(manager, ["--release", link]);
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("not changed: install-ai-worker: --release");
    expect(linked.stderr).toContain("is a symbolic link");
    const other = path.join(tmp, "elsewhere", SHA);
    fs.mkdirSync(other, { recursive: true });
    const outside = dryRun(manager, ["--release", other]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("is not");
  });

  it("without --release plans prepare-release.sh for HEAD", () => {
    const main = path.join(tmp, `git-main-${manager}`);
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(path.join(main, "package.json"), "{}");
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: main, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const r = dryRun(manager, [], "postgres://u@h/d", main);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`prepare-release.sh ${head} --root ${fs.realpathSync(main)}`);
    expect(r.stdout).toContain(`release:   ${fs.realpathSync(main)}/data/releases/ai-worker/${head}`);
  });
});

describe("--dry-run unit escapes (systemd)", () => {
  it("escapes values per setting, and sd_unit_db_url reads the URL back exactly (literal \\ \" %)", () => {
    const odd = path.join(tmp, 'check out%1 "q" $HOME');
    fs.mkdirSync(path.join(odd, "data"), { recursive: true });
    fs.writeFileSync(path.join(odd, "package.json"), "{}");
    const oddRelease = makeRelease(odd, SHA);
    const url = 'postgres://u@127.0.0.1:5433/d\\b"c%25x$y';
    const r = dryRun("systemd", ["--release", oddRelease], url, odd);
    expect(r.status, r.stderr).toBe(0);
    const esc = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
    expect(r.stdout).toContain(`WorkingDirectory=${oddRelease.replaceAll("%", "%%")}\n`);
    expect(r.stdout).toContain(`--log-dir "${esc(path.join(odd, "data/logs")).replaceAll("$", () => "$$")}"`);
    expect(r.stdout).toContain(`Environment="JOB_RADAR_PROFILE_DIR=${esc(path.join(odd, "data/profile"))}"`);
    const unit = r.stdout.split("--- definition")[1]?.split("\n").slice(1).join("\n").split("--- would run ---")[0] ?? "";
    const file = path.join(tmp, "roundtrip.service");
    fs.writeFileSync(file, unit);
    const back = spawnSync("bash", ["-c", `source "$1"; sd_unit_db_url "$2"`, "_", aiWorkerLib, file], { encoding: "utf8" });
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toBe(url);
  });
});

/** --print-release reads only the definition file: PATH has no node, launchctl or systemctl. */
describe("--print-release", () => {
  let bin = "";
  beforeAll(() => {
    bin = path.join(tmp, "bare-bin");
    fs.mkdirSync(bin);
    for (const dir of ["/usr/bin", "/bin"]) {
      for (const name of fs.readdirSync(dir)) {
        if (["node", "launchctl", "systemctl", "pnpm", "npx"].includes(name) || fs.existsSync(path.join(bin, name))) continue;
        fs.symlinkSync(path.join(dir, name), path.join(bin, name));
      }
    }
    if (!fs.existsSync(path.join(bin, "plutil"))) fs.symlinkSync(path.join(plutilShim, "plutil"), path.join(bin, "plutil"));
  });

  function printRelease(manager: string, main: string, extra: Record<string, string> = {}) {
    const e = env(manager, extra);
    e.PATH = bin;
    if (!fs.existsSync(path.join("/usr/bin", "plutil"))) {
      // the shim runs on node: give it node through its own variable, never on the script's PATH
      e.PLUTIL_SHIM_NODE = process.execPath;
    }
    return spawnSync("/bin/bash", [script, "--print-release", "--root", main], { encoding: "utf8", env: e });
  }
  function fresh(name: string): { main: string; h: string; x: string } {
    const main = path.join(tmp, name, "main");
    const h = path.join(tmp, name, "home");
    const x = path.join(tmp, name, "xdg");
    for (const d of [path.join(main, "data/config"), h, x]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(main, "package.json"), "{}");
    return { main, h, x };
  }
  const plist = (label: string, wd: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>WorkingDirectory</key>\n  <string>${wd}</string>\n</dict>\n</plist>\n`;
  const writePlist = (h: string, label: string, wd: string) => {
    fs.mkdirSync(path.join(h, "Library/LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(h, "Library/LaunchAgents", `${label}.plist`), plist(label, wd));
  };
  const writeUnit = (x: string, body: string) => {
    fs.mkdirSync(path.join(x, "systemd/user"), { recursive: true });
    fs.writeFileSync(path.join(x, "systemd/user/job-radar-ai-worker.service"), body);
  };

  it("launchd: 0 and exactly one line, the release; 4 for a checkout; 3 when nothing or only the old label; 1 when ambiguous", () => {
    const { main, h } = fresh("pr-launchd");
    const rel = path.join(fs.realpathSync(main), "data/releases/ai-worker", SHA);
    expect(printRelease("launchd", main, { HOME: h }).status).toBe(3);
    writePlist(h, "de.jobradar.ai-worker", rel);
    expect(printRelease("launchd", main, { HOME: h }).status).toBe(3);
    fs.rmSync(path.join(h, "Library/LaunchAgents/de.jobradar.ai-worker.plist"));
    writePlist(h, "io.jobradar.ai-worker", rel);
    const ok = printRelease("launchd", main, { HOME: h });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(`${rel}\n`);
    writePlist(h, "io.jobradar.ai-worker", fs.realpathSync(main));
    const checkout = printRelease("launchd", main, { HOME: h });
    expect(checkout.status).toBe(4);
    expect(checkout.stdout).toBe("");
    expect(checkout.stderr).toContain(fs.realpathSync(main));
    writePlist(h, "de.jobradar.ai-worker", rel);
    expect(printRelease("launchd", main, { HOME: h }).status).toBe(1);
  });

  it("systemd: finds the unit under XDG_CONFIG_HOME, decodes %%, and refuses a % sequence it never writes", () => {
    const { main, x } = fresh("pr%systemd");
    const rel = path.join(fs.realpathSync(main), "data/releases/ai-worker", SHA);
    expect(printRelease("systemd", main, { XDG_CONFIG_HOME: x }).status).toBe(3);
    writeUnit(x, `[Service]\nWorkingDirectory=${rel.replaceAll("%", "%%")}\n`);
    const ok = printRelease("systemd", main, { XDG_CONFIG_HOME: x });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(`${rel}\n`);
    writeUnit(x, `[Service]\nWorkingDirectory=${rel.replaceAll("%", "%n")}\n`);
    expect(printRelease("systemd", main, { XDG_CONFIG_HOME: x }).status).toBe(1);
    writeUnit(x, `[Service]\nWorkingDirectory=${rel.replaceAll("%", "%%")}\nWorkingDirectory=/tmp\n`);
    expect(printRelease("systemd", main, { XDG_CONFIG_HOME: x }).status).toBe(1);
    writeUnit(x, `[Service]\nWorkingDirectory=${fs.realpathSync(main).replaceAll("%", "%%")}\n`);
    expect(printRelease("systemd", main, { XDG_CONFIG_HOME: x }).status).toBe(4);
  });
});

describe("the main checkout", () => {
  it("still accepts --root naming a workspace checkout that holds the product in job-radar/", () => {
    const ws = path.join(tmp, "workspace");
    fs.mkdirSync(path.join(ws, "job-radar/data/releases/ai-worker"), { recursive: true });
    fs.writeFileSync(path.join(ws, "job-radar/package.json"), "{}");
    const rel = makeRelease(path.join(ws, "job-radar"), SHA);
    const r = spawnSync("bash", [script, "--dry-run", "--root", ws, "--database-url", "postgres://u@h/d", "--release", rel], { encoding: "utf8", env: env("systemd") });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`checkout:  ${path.join(ws, "job-radar")}`);
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
  afterAll(() => {
    if (stubs && path.basename(stubs).startsWith("ai-worker-stubs-")) fs.rmSync(stubs, { recursive: true, force: true });
  });

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
    const none = run(uninstall, ["--root", root]);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("no job-radar-ai-worker.service installed");
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), "[Unit]\n");
    const stuck = run(uninstall, ["--root", root], { XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("loginctl enable-linger");
    expect(fs.existsSync(unitFile())).toBe(true);
  });
});
