import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throw-away "main checkout" for the ai-worker install / uninstall tests, with a home directory, a unit directory and
 * the service-manager simulator (tests/ops/sim) first on PATH. Releases are real commits of a temporary git repository,
 * each with a valid .release.json (sha, tree, sha256 of pnpm-lock.yaml) under data/releases/ai-worker/<sha>/; their
 * node_modules/tsx is a link to this repository's tsx and src/ai-worker/index.ts imports tests/fixtures/release/
 * fake-worker.mjs. No release guard is put in (the fake worker imports from this repository, outside the release).
 * Nothing here touches a real launchd / systemd, a real checkout or a real database; every path is under one mkdtemp
 * directory, removed by `cleanup()` together with every process the simulator started.
 */
const repo = path.resolve(import.meta.dirname, "../..");
export const SIM_BIN = path.join(repo, "tests/ops/sim");
const PLUTIL_SHIM = path.join(repo, "tests/ops/sim/plutil-shim");
export const INSTALL = path.join(repo, "scripts/ops/install-ai-worker.sh");
export const UNINSTALL = path.join(repo, "scripts/ops/uninstall-ai-worker.sh");
const FAKE_WORKER = path.join(repo, "tests/fixtures/release/fake-worker.mjs");
const RELEASES_SH = path.join(repo, "scripts/ops/lib/releases.sh");
const TSX = fs.realpathSync(path.join(repo, "node_modules/tsx"));

export type Manager = "launchd" | "systemd";
export type WorkerMode = "ok" | "no-lock" | "no-heartbeat" | "ignore-term" | "ignore-term-no-heartbeat" | "crash" | "slow-term";

export interface SimCall {
  t: number;
  tool: "launchctl" | "systemctl";
  argv: string[];
}

export interface WorkerStart {
  pid: number;
  mode: WorkerMode;
  release: string;
  cwd: string;
  argv: string[];
  execArgv: string[];
  env: Record<string, string | null>;
}

function hasPlutil(): boolean {
  return spawnSync("sh", ["-c", "command -v plutil"], { encoding: "utf8" }).status === 0;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export class FakeInstall {
  readonly tmp: string;
  readonly main: string;
  readonly home: string;
  readonly xdg: string;
  readonly simDir: string;
  readonly control: string;
  readonly record: string;
  private releaseCount = 0;

  constructor(readonly manager: Manager, opts: { stopTimeout?: number; swapTimeout?: number; keep?: number } = {}) {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-sim-")));
    this.main = path.join(this.tmp, "main");
    this.home = path.join(this.tmp, "home");
    this.xdg = path.join(this.tmp, "xdg");
    this.simDir = path.join(this.tmp, "sim");
    this.control = path.join(this.tmp, "worker-control.json");
    this.record = path.join(this.tmp, "worker-starts.jsonl");
    for (const dir of [this.main, this.home, this.xdg, this.simDir, path.join(this.main, "data/config")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.control, "{}");
    fs.writeFileSync(this.record, "");
    fs.writeFileSync(path.join(this.simDir, "calls.log"), "");
    // the main checkout: package.json (the install script's root check), the user's schedule.yaml with test timeouts
    fs.writeFileSync(path.join(this.main, "package.json"), '{ "name": "fake-main" }\n');
    fs.writeFileSync(path.join(this.main, ".gitignore"), "data/\n");
    this.setDeploy(opts);
    this.git("init", "-q");
    this.commit("initial");
  }

  setDeploy(opts: { stopTimeout?: number; swapTimeout?: number; keep?: number; label?: string }): void {
    const lines = [
      "deploy:",
      `  ai_worker_stop_timeout_seconds: ${opts.stopTimeout ?? 10}`,
      `  ai_worker_swap_timeout_seconds: ${opts.swapTimeout ?? 20}`,
      `  ai_worker_releases_keep: ${opts.keep ?? 3}`,
    ];
    if (opts.label) lines.push("doctor:", `  ai_worker_launchd_label: ${opts.label}`);
    fs.writeFileSync(path.join(this.main, "data/config/schedule.yaml"), `${lines.join("\n")}\n`);
  }

  git(...args: string[]): string {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: this.main, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A new commit (pnpm-lock.yaml and a version file); returns its sha. */
  commit(note: string): string {
    fs.writeFileSync(path.join(this.main, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(this.main, "version.txt"), `${note}\n`);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", note);
    return this.git("rev-parse", "HEAD");
  }

  releasesDir(): string {
    return path.join(this.main, "data/releases/ai-worker");
  }

  /**
   * A release for a new commit (or `sha`): the files a real one has that the install script and the worker use.
   * `created` orders the clean-up; `checkNode` copies the repository's check-node-engines.mjs into it.
   */
  release(opts: { sha?: string; created?: string; checkNode?: { engines: string } } = {}): string {
    this.releaseCount += 1;
    const sha = opts.sha ?? this.commit(`release ${this.releaseCount}`);
    const dir = path.join(this.releasesDir(), sha);
    fs.mkdirSync(path.join(dir, "src/ai-worker"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.symlinkSync(TSX, path.join(dir, "node_modules/tsx"));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), '{ "compilerOptions": { "module": "esnext", "target": "es2022" } }\n');
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fake-release", type: "module", engines: { node: opts.checkNode?.engines ?? ">=1.0.0 <1000" } }));
    fs.writeFileSync(path.join(dir, "src/ai-worker/index.ts"), `import ${JSON.stringify(`file://${FAKE_WORKER}`)};\n`);
    if (opts.checkNode) {
      fs.mkdirSync(path.join(dir, "scripts/ops"), { recursive: true });
      fs.copyFileSync(path.join(repo, "scripts/ops/check-node-engines.mjs"), path.join(dir, "scripts/ops/check-node-engines.mjs"));
    }
    const tree = this.git("rev-parse", `${sha}^{tree}`);
    const marker = { sha, tree, lockfile_sha256: sha256(path.join(dir, "pnpm-lock.yaml")), prod_only: true, created: opts.created ?? new Date().toISOString().replace(/\.\d+Z$/, "Z") };
    fs.writeFileSync(path.join(dir, ".release.json"), `${JSON.stringify(marker, null, 2).replace(/^ {2}/gm, "  ")}\n`);
    return dir;
  }

  /** The worker behaviour per release sha (or "default"). */
  setModes(modes: Record<string, WorkerMode>): void {
    fs.writeFileSync(this.control, JSON.stringify(modes));
  }

  inject(values: Record<string, unknown>): void {
    const state = this.state();
    state.inject = { ...(state.inject as object), ...values };
    fs.writeFileSync(path.join(this.simDir, "state.json"), JSON.stringify(state, null, 2));
  }

  state(): Record<string, unknown> & { launchd?: { loaded: Record<string, { pid: number; plist: string }>; disabled: Record<string, boolean> }; systemd?: { units: Record<string, { active: string; pid: number }> }; spawned?: number[] } {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.simDir, "state.json"), "utf8")) as ReturnType<FakeInstall["state"]>;
    } catch {
      return {};
    }
  }

  calls(): SimCall[] {
    return fs
      .readFileSync(path.join(this.simDir, "calls.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SimCall);
  }

  /** The state-changing calls only, as "tool verb [target]" strings. */
  changes(): string[] {
    const verbs = new Set(["enable", "disable", "bootstrap", "bootout", "start", "stop", "daemon-reload"]);
    return this.calls()
      .map((c) => c.argv.filter((a) => a !== "--user"))
      .filter((a) => verbs.has(a[0] ?? ""))
      .map((a) => a.join(" "));
  }

  starts(): WorkerStart[] {
    return fs
      .readFileSync(this.record, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as WorkerStart);
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.home,
      XDG_CONFIG_HOME: this.xdg,
      JOB_RADAR_SERVICE_MANAGER: this.manager,
      JOB_RADAR_SIM_DIR: this.simDir,
      FAKE_WORKER_CONTROL: this.control,
      FAKE_WORKER_RECORD: this.record,
      PATH: `${SIM_BIN}:${hasPlutil() ? "" : `${PLUTIL_SHIM}:`}${process.env.PATH ?? ""}`,
    };
    // no inherited lock token, NODE_OPTIONS or database: only what a test passes (--database-url, .env, or extra)
    delete env.JOB_RADAR_RELEASES_LOCK_TOKEN;
    delete env.NODE_OPTIONS;
    delete env.DATABASE_URL;
    return { ...env, ...extra };
  }

  run(script: string, args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
    return spawnSync("bash", [script, ...args], { encoding: "utf8", env: this.env(extra), timeout: 240_000 });
  }

  install(args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
    return this.run(INSTALL, ["--root", this.main, ...args], extra);
  }

  /** The install script in its own process group (like a terminal's foreground job), for the signal tests. */
  spawnInstall(args: string[], extra: Record<string, string> = {}): { child: ChildProcess; done: Promise<{ code: number | null; out: string }> } {
    const child = spawn("bash", [INSTALL, "--root", this.main, ...args], { env: this.env(extra), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on("close", (code) => resolve({ code, out })));
    return { child, done };
  }

  /** Takes the release lock the way a deploy script does (releases.sh); returns the token to pass on. */
  takeLock(): string {
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(RELEASES_SH)}; releases_lock_acquire "$1" >&2 && printf '%s' "$JOB_RADAR_RELEASES_LOCK_TOKEN"`, "_", this.main], { encoding: "utf8", env: this.env() });
    if (r.status !== 0 || !r.stdout) throw new Error(`cannot take the release lock: ${r.stderr}`);
    return r.stdout;
  }

  lockDir(): string {
    return path.join(this.releasesDir(), ".lock");
  }

  /** The in-flight records (file name = pid) and what each one says. */
  inflight(): Record<string, string> {
    const dir = path.join(this.lockDir(), "inflight");
    if (!fs.existsSync(dir)) return {};
    return Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));
  }

  /** <main>/.env with these lines. */
  writeEnv(lines: Record<string, string>): void {
    fs.writeFileSync(path.join(this.main, ".env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
  }

  /** launchd: one label's enable override in the simulator (true = disabled, false = enabled, null = none). */
  setLaunchdOverride(label: string, disabled: boolean | null): void {
    const state = this.state() as Record<string, unknown> & { launchd: { loaded: object; disabled: Record<string, boolean> } };
    state.launchd ??= { loaded: {}, disabled: {} };
    if (disabled === null) delete state.launchd.disabled[label];
    else state.launchd.disabled[label] = disabled;
    fs.writeFileSync(path.join(this.simDir, "state.json"), JSON.stringify(state, null, 2));
  }

  /** Runs the simulator's launchctl / systemctl as the scripts would (for setting up a state). */
  sim(tool: "launchctl" | "systemctl", ...args: string[]): SpawnSyncReturns<string> {
    return spawnSync(path.join(SIM_BIN, tool), args, { encoding: "utf8", env: this.env() });
  }

  /** The temporary files the install script made under TMPDIR (pass tmpEnv() to the run). */
  tmpLeft(): string[] {
    const dir = path.join(this.tmp, "tmpdir");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith("ai-worker-")) : [];
  }

  tmpEnv(): Record<string, string> {
    const dir = path.join(this.tmp, "tmpdir");
    fs.mkdirSync(dir, { recursive: true });
    return { TMPDIR: dir };
  }

  identity(): Record<string, string> {
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(path.join(repo, "scripts/ops/lib/ai-worker.sh"))}; ai_worker_identity "$1"`, "_", this.main], { encoding: "utf8", env: this.env() });
    const out: Record<string, string> = { status: String(r.status) };
    for (const line of r.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  plist(label: string): string {
    return path.join(this.home, "Library/LaunchAgents", `${label}.plist`);
  }

  unitFile(): string {
    return path.join(this.xdg, "systemd/user/job-radar-ai-worker.service");
  }

  backupDir(): string {
    return path.join(this.main, "data/run/ai-worker-swap-backup");
  }

  /** The PID the simulator reports for a label (launchd) or the unit (systemd), 0 when none. */
  servicePid(label = "io.jobradar.ai-worker"): number {
    const s = this.state();
    const pid = this.manager === "launchd" ? s.launchd?.loaded[label]?.pid : s.systemd?.units["job-radar-ai-worker.service"]?.pid;
    if (!pid) return 0;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return 0;
    }
  }

  /** Kills every process the simulator started, then removes the temporary directory. */
  async cleanup(): Promise<void> {
    for (const pid of this.state().spawned ?? []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    if (path.basename(this.tmp).startsWith("ai-worker-sim-")) {
      // release directories may be read-only after a test made them so
      spawnSync("chmod", ["-R", "u+w", this.tmp]);
      fs.rmSync(this.tmp, { recursive: true, force: true });
    }
  }
}
