import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { parseDocument } from "yaml";

import { CONFIG_WRITE_LOCK_KEY } from "@/lib/db/config-write-lock";

/**
 * The real scripts/ops/deploy.sh, with the real config:migrate, config:init, config:plan and config:check and the real
 * lib/releases.sh, in a throw-away git checkout, taking the real config write lock on the integration database. Whatever
 * touches anything else is a recording stub: docker, the ai-worker install and release scripts, worker-heartbeat.ts, launchctl,
 * pnpm install and the doctor. Every stub records the bytes of data/config and data/profile at the moment it runs.
 *
 * The stubs come first on PATH, HOME is a temp directory and the database is only ever named by the checkout's `.env` or the
 * environment set here. The tests/ops/deploy-script.test.ts file tests the script's branches with everything stubbed; this
 * one tests what it does to real files.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const FAKE_DEPLOY_PROD = path.join(REPO, "tests/fixtures/ops/fake-deploy-prod.sh");
const PAUSE_PRELOAD = path.join(REPO, "tests/fixtures/ops/pause-after-first-publish.mjs");
const TCP_GATE = path.join(REPO, "tests/fixtures/ops/tcp-gate.mjs");
const OWNER_FIXTURE = fs.readFileSync(path.join(REPO, "tests/fixtures/ops/lock-owner-wrapper.txt"), "utf8");
const FIXTURE_TOKEN = "0123456789abcdef0123456789abcdef";
const HANG_GUARD_MS = 180_000;

const ARGS = ["--skip-pull", "--settle", "0"];
const NO_WORKER = ["--skip-pull", "--no-ai-worker"];
const WRITES = ["pnpm config:migrate --write --convert-overlays", "pnpm config:init", "pnpm config:plan --deploy --check", "pnpm config:migrate --prune-backups"];
const OLD_FILES = ["notify", "interests"] as const;

let root = "";
let work = "";
let stubs = "";
let log = "";
let lockDir = "";
let deploySh = "";
let baseCommit = "";
let databaseEnv = "";
let hostDatabaseUrl = "";
let target = "";
let sql: postgres.Sql;

const inTest = (...parts: string[]): string => path.join(work, ...parts);
const configFile = (name: string): string => inTest("data/config", `${name}.yaml`);

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

const STUB_LIB = `# sourced by every stub
record() {
  local sum
  sum="$(cd "$WORK" && find data/config data/profile -type f -exec cksum {} + 2>/dev/null | LC_ALL=C sort | cksum)"
  printf '%s\\t%s\\n' "$*" "$sum" >> "$DEPLOY_TEST_LOG"
}
note() { printf '# %s\\n' "$*" >> "$DEPLOY_TEST_LOG"; }
# STUB_<key>_HOOK runs (a failing hook is the stub's failure), STUB_<key>_EXIT ends the stub.
hook_and_exit() {
  local hook="STUB_$1_HOOK" code="STUB_$1_EXIT"
  if [[ -n "\${!hook:-}" ]]; then bash -c "\${!hook}" || exit $?; fi
  if [[ -n "\${!code:-}" ]]; then exit "\${!code}"; fi
}
`;

const DOCKER_STUB = `#!/usr/bin/env bash
source "$STUB_LIB"
record "docker $*"
export DEPLOY_PID=$PPID
case "$*" in
  info*) exit 0 ;;
  "volume inspect"*) echo "Error: no such volume" >&2; exit 1 ;;
  "image inspect"*) name="\${*: -1}"; echo "sha256:built-\${name#img-}"; exit 0 ;;
  inspect*)
    id="\${*: -1}"; var="STUB_INSPECT_\${id//-/_}"
    if [[ -n "\${!var+x}" ]]; then echo "\${!var}"; else echo "true sha256:built-\${id#cid-}"; fi
    exit 0 ;;
  "builder prune"*|"image prune"*) echo "Total:	0B"; exit 0 ;;
esac
case "$*" in
  *" config --images "*) printf 'postgres:17\\nimg-%s\\n' "\${*: -1}"; exit 0 ;;
  *" config --format json "*) echo '{"name":"radar-test","services":{"db":{"image":"postgres:17"},"web":{"image":"img-web"},"runner":{"image":"img-runner"}}}'; exit 0 ;;
  *" config -q") hook_and_exit config; exit 0 ;;
  *" config --format json") echo '{"services":{"db":{},"web":{"depends_on":{"db":{}}},"runner":{"depends_on":{"db":{}}},"jobspy":{}}}'; exit 0 ;;
  *" ps -a -q "*)
    var="STUB_CONTAINERS_\${*: -1}"
    if [[ -n "\${!var+x}" ]]; then [[ -z "\${!var}" ]] || printf '%s\\n' "\${!var}"; else echo "cid-\${*: -1}"; fi
    exit 0 ;;
  *" ps --status running --services"*) [[ "\${DB_RUNNING:-0}" != 1 ]] || echo db; exit 0 ;;
  *" build") hook_and_exit build; exit 0 ;;
  *" up "*) note "up"; hook_and_exit up; exit 0 ;;
esac
exit 0
`;

/** pnpm: the config commands run the line package.json has; everything else is recorded only. */
function pnpmStub(): string {
  const scripts = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const lines = ["config:init", "config:migrate", "config:plan", "config:check"]
    .map((name) => {
      const line = scripts[name];
      if (line === undefined) throw new Error(`package.json has no ${name}`);
      return `  ${name}) shift; exec ${line} "$@" ;;`;
    })
    .join("\n");
  return `#!/usr/bin/env bash
source "$STUB_LIB"
export DEPLOY_PID=$PPID
printf '%s\\n' "$PPID" > "$DEPLOY_TEST_LOG.deploy-pid"
record "pnpm $*"
key="$*"; key="\${key//[^A-Za-z0-9]/_}"
if [[ "$1" == config:* ]]; then
  owner="$(sed -n 's/^token=//p' "$LOCK/owner" 2>/dev/null)"
  note "at pnpm $* token=$([[ -n "$owner" && "$owner" == "\${JOB_RADAR_RELEASES_LOCK_TOKEN:-}" ]] && echo same || echo other) lock=$([[ -d "$LOCK" ]] && echo 1 || echo 0) url=\${DATABASE_URL:-}"
fi
if [[ "$*" == "run doctor" ]]; then note "doctor lock=$([[ -d "$LOCK" ]] && echo 1 || echo 0) reason=\${CONFIG_PENDING_REASON:-}"; fi
hook_and_exit "$key"
if [[ "\${STUB_PAUSE:-}" == "$key" ]]; then export NODE_OPTIONS="--import=$PAUSE_PRELOAD"; fi
export PATH="$WORK/node_modules/.bin:$PATH"
case "$1" in
${lines}
esac
exit 0
`;
}

const STEP_STUB = (name: string, key: string): string => `#!/usr/bin/env bash
source "$STUB_LIB"
if [[ "\${1:-}" == --print-release ]]; then git -C "$WORK" rev-parse HEAD | sed "s|^|$WORK/data/releases/ai-worker/|"; exit 0; fi
export DEPLOY_PID=$PPID
record "${name} $*"
note "${name} token=\${JOB_RADAR_RELEASES_LOCK_TOKEN:-} owner=$(sed -n 's/^token=//p' "$LOCK/owner" 2>/dev/null)"
hook_and_exit ${key}
exit 0
`;

const HEARTBEAT_STUB = `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
spawnSync("bash", ["-c", 'source "$STUB_LIB"; record "$1"; note "heartbeat url=$DATABASE_URL"', "_", "heartbeat " + args.join(" ")], { stdio: "ignore" });
if (args.includes("--lock-holder")) {
  const stall = process.env.STUB_LOCK_HOLDER_STALL;
  if (stall) {
    fs.writeFileSync(path.join(stall, "reached"), "");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + 120000;
    while (!fs.existsSync(path.join(stall, "go")) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 20);
  }
  process.exit(Number(process.env.STUB_LOCK_HOLDER_EXIT ?? 0));
}
if (args.includes("--holder")) console.log(JSON.stringify({ status: "none" }));
if (args.includes("--now")) console.log(JSON.stringify({ now: new Date().toISOString() }));
`;

const PS_STUB = `#!/usr/bin/env bash
# The worker scan sees no worker; everything else is the real ps.
if [[ "$*" == "-A -o pid=,args=" ]]; then exit 0; fi
exec /bin/ps "$@"
`;

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env: cleanEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The environment of a production shell: nothing of the test runner, no database, no paths to other config directories. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(__)?VITEST|^JOB_RADAR_|^GIT_|^NODE_OPTIONS$|^NODE_ENV$|^DATABASE_URL$|^TEST$|^XDG_CONFIG_HOME$|^DB_CONNECT_TIMEOUT_SECONDS$|^POSTGRES_|^DB_HOST_PORT$/.test(key)) delete env[key];
  }
  return env;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    PATH: `${stubs}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    HOME: path.join(root, "home"),
    JOB_RADAR_SERVICE_MANAGER: "launchd",
    DEPLOY_TEST_LOG: log,
    STUB_LIB: path.join(stubs, "stub-lib.sh"),
    PAUSE_PRELOAD,
    WORK: work,
    LOCK: lockDir,
    ...extra,
  };
}

interface Run {
  status: number;
  out: string;
  calls: string[];
  notes: string[];
  /** The bytes of the user directories when each stub ran, in order. */
  sums: string[];
  sumAt: (call: string) => string | undefined;
}

interface Running {
  pid: number;
  output: () => string;
  done: Promise<Run>;
  child: ChildProcess;
}

const active = new Set<Running>();
const pauseDirs: string[] = [];
let runs = 0;

function collect(status: number, out: string): Run {
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  const entries = lines.filter((l) => !l.startsWith("# ")).map((l) => l.split("\t") as [string, string]);
  return {
    status,
    out,
    calls: entries.map(([call]) => call),
    notes: lines.filter((l) => l.startsWith("# ")).map((l) => l.slice(2)),
    sums: entries.map(([, sum]) => sum),
    sumAt: (call) => entries.find(([c]) => c === call)?.[1],
  };
}

/**
 * Starts bash in its own process group, with the output in a file. A checkout without a database in its `.env` would reach the
 * compose default, the host's real database: only a test that stops before any database use may pass `noDatabase`.
 */
function start(command: string[], extra: Record<string, string> = {}, { noDatabase = false, keepLog = false } = {}): Running {
  const envText = fs.existsSync(inTest(".env")) ? fs.readFileSync(inTest(".env"), "utf8") : "";
  if (!noDatabase && !extra.DATABASE_URL && !/^(DB_HOST_PORT|DATABASE_URL)=/m.test(envText)) throw new Error("this run would use the default database");
  if (!keepLog) fs.writeFileSync(log, "");
  const outFile = path.join(root, `run-${++runs}.out`);
  const fd = fs.openSync(outFile, "w");
  const child = spawn("bash", command, { cwd: work, env: childEnv(extra), detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const output = (): string => fs.readFileSync(outFile, "utf8");
  const done = new Promise<Run>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`timed out:\n${output()}`)), HANG_GUARD_MS);
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      active.delete(running);
      resolve(collect(code ?? 128 + (signal ? os.constants.signals[signal] : 0), output()));
    });
  });
  const running: Running = { pid: child.pid ?? -1, output, done, child };
  active.add(running);
  return running;
}

const deploy = (args: string[] = ARGS, extra: Record<string, string> = {}): Promise<Run> => start([deploySh, ...args], extra).done;

async function waitFor(what: string, cond: () => boolean, run?: Running): Promise<void> {
  const until = performance.now() + HANG_GUARD_MS;
  while (!cond()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}:\n${run?.output() ?? ""}`);
    if (run && !active.has(run)) throw new Error(`the deploy ended while waiting for ${what}:\n${run.output()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function newPauseDir(): string {
  const dir = fs.mkdtempSync(path.join(root, "pause-"));
  pauseDirs.push(dir);
  return dir;
}

const pauseFile = (dir: string, name: string): string => path.join(dir, name);
const reachedPause = (dir: string, run: Running): Promise<void> => waitFor("the writer to stop", () => fs.existsSync(pauseFile(dir, "reached")), run);
const letGo = (dir: string): void => fs.writeFileSync(pauseFile(dir, "go"), "");
const waitForSignal = (run: Running): Promise<void> => waitFor("the deploy to record the signal", () => run.output().includes("stopping after this step"), run);

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A hash of every file under the user directories, names included. */
function userBytes(): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      hash.update(full);
      if (entry.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(inTest("data/config"));
  walk(inTest("data/profile"));
  return hash.digest("hex");
}

/** An existing install with two files on an old schema version: the plan has something to migrate, then something to create. */
function existingInstall(): void {
  for (const name of OLD_FILES) write(configFile(name), fs.readFileSync(path.join(REPO, `tests/fixtures/config/${name}.v1.yaml`), "utf8"));
  fs.mkdirSync(inTest("data/profile"), { recursive: true });
}

/** data/config/schedule.yaml: the shipped file with these values set. */
function userSchedule(values: [string[], unknown][]): void {
  const doc = parseDocument(fs.readFileSync(inTest("config/schedule.yaml"), "utf8"));
  for (const [keys, value] of values) doc.setIn(keys, value);
  write(configFile("schedule"), doc.toString());
}

/** The real config:check: every user file loads. */
function loads(): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/config-check.ts"], { cwd: work, env: childEnv({}), encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Sessions holding the config write lock on the integration database. */
async function configLockHolders(): Promise<number> {
  const [classid, objid] = CONFIG_WRITE_LOCK_KEY;
  const rows = await sql<{ count: string }[]>`
    select count(*) from pg_locks
    where locktype = 'advisory' and granted and classid = ${classid} and objid = ${objid}
      and database = (select oid from pg_database where datname = current_database())`;
  return Number(rows[0]?.count);
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assertUntouched(r: Run, before: string): void {
  for (const command of WRITES) expect(r.calls).not.toContain(command);
  expect(new Set(r.sums).size, r.out).toBeLessThanOrEqual(1);
  expect(userBytes()).toBe(before);
}

function assertPending(r: Run, reason: string, before?: string): void {
  expect(r.status, r.out).toBe(2);
  expect(r.out).toContain(`config writes pending: ${reason}`);
  expect(r.notes).toContain(`doctor lock=0 reason=${reason}`);
  expect(r.out).toContain(`Deployed, but the config writes are pending: ${reason}. The next deploy retries them.`);
  if (before !== undefined) assertUntouched(r, before);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deploy-writes-")));
  work = path.join(root, "work");
  stubs = path.join(root, "stubs");
  log = path.join(root, "calls.log");
  lockDir = inTest("data/releases/ai-worker/.lock");
  deploySh = inTest("scripts/ops/deploy.sh");

  fs.mkdirSync(work);
  for (const entry of ["src", "scripts", "config", "messages", "package.json", "tsconfig.json", "compose.yaml"]) {
    fs.cpSync(path.join(REPO, entry), path.join(work, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(work, "node_modules"));
  write(path.join(work, ".gitignore"), "/node_modules\n/data/\n/.env\n");

  write(path.join(stubs, "stub-lib.sh"), STUB_LIB);
  write(path.join(stubs, "docker"), DOCKER_STUB, 0o755);
  write(path.join(stubs, "pnpm"), pnpmStub(), 0o755);
  write(path.join(stubs, "ps"), PS_STUB, 0o755);
  for (const tool of ["launchctl", "systemctl"]) write(path.join(stubs, tool), '#!/usr/bin/env bash\nexit 1\n', 0o755);
  write(inTest("scripts/ops/install-ai-worker.sh"), STEP_STUB("install-ai-worker.sh", "install"), 0o755);
  write(inTest("scripts/ops/prepare-release.sh"), STEP_STUB("prepare-release.sh", "prepare"), 0o755);
  write(inTest("scripts/ops/backup.sh"), STEP_STUB("backup.sh", "backup"), 0o755);
  write(inTest("scripts/ops/worker-heartbeat.ts"), HEARTBEAT_STUB);

  fs.mkdirSync(path.join(root, "home"));
  spawnSync("git", ["init", "-q", "-b", "main", work], { env: cleanEnv() });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  baseCommit = git("rev-parse", "HEAD");

  const url = new URL(inject("testDatabaseUrl"));
  // Forced to this host like the script's own fallback: the test server listens there.
  target = `127.0.0.1:${url.port || "5432"}`;
  const [user, password, name] = [decodeURIComponent(url.username), decodeURIComponent(url.password), url.pathname.slice(1)];
  databaseEnv = `POSTGRES_USER=${user}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${name}\nDB_HOST_PORT=${url.port || "5432"}\n`;
  hostDatabaseUrl = `postgres://${user}:${password}@${target}/${name}`;
  sql = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(inTest("data"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "home"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "home/Library/LaunchAgents"), { recursive: true });
  fs.writeFileSync(log, "");
  // the throw-away checkout, never this repository
  git("reset", "-q", "--hard", baseCommit);
  write(inTest(".env"), databaseEnv);
});

afterEach(async () => {
  // A failed test can leave a writer waiting or a deploy running: only processes this test started.
  for (const dir of pauseDirs.splice(0)) {
    letGo(dir);
    const pid = Number(fs.existsSync(pauseFile(dir, "pid")) ? fs.readFileSync(pauseFile(dir, "pid"), "utf8") : 0);
    if (pid > 1 && !fs.existsSync(pauseFile(dir, "exit"))) await waitFor("the writer to end", () => gone(pid)).catch(() => process.kill(pid, "SIGKILL"));
  }
  for (const run of [...active]) {
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await run.done.catch(() => undefined);
  }
});

describe("scripts/ops/deploy.sh: real config writes", { timeout: 300_000 }, () => {
  describe("the order", () => {
    it("pending writes: everything is read-only until the ai-worker step, the writes hold the lock, then the lock is released", async () => {
      existingInstall();
      const before = userBytes();
      const r = await deploy();
      expect(r.status, r.out).toBe(0);

      const position = (matches: (call: string) => boolean): number => r.calls.findIndex(matches);
      const worker = position((c) => c.startsWith("install-ai-worker.sh --release "));
      const seen = [
        position((c) => c === "pnpm install --frozen-lockfile"),
        position((c) => c === "pnpm config:init --env-only"),
        position((c) => c === "pnpm config:check"),
        position((c) => c === "pnpm config:plan --deploy"),
        position((c) => c.startsWith("docker compose ") && c.endsWith(" build")),
        position((c) => c.startsWith("prepare-release.sh ")),
        position((c) => c === "pnpm ops:drain"),
        position((c) => c.startsWith("docker compose ") && c.includes(" up ")),
        position((c) => c === "pnpm migrate:run"),
        worker,
        ...WRITES.map((command) => r.calls.indexOf(command)),
        position((c) => c.startsWith("docker builder prune")),
        position((c) => c === "pnpm run doctor"),
      ];
      expect(seen, r.calls.join("\n")).not.toContain(-1);
      expect(seen).toEqual([...seen].sort((x, y) => x - y));
      const holder = r.calls.findIndex((c) => c.startsWith("heartbeat --holder"));
      expect(holder).toBeGreaterThan(worker);
      expect(holder).toBeLessThan(r.calls.indexOf(WRITES[0] ?? ""));

      // Not a byte changes before the first write; every stub up to it saw the same files.
      const firstWrite = r.calls.indexOf(WRITES[0] ?? "");
      expect(new Set(r.sums.slice(0, firstWrite + 1)).size).toBe(1);
      expect(r.sumAt(WRITES[1] ?? "")).not.toBe(r.sumAt(WRITES[0] ?? ""));
      expect(userBytes()).not.toBe(before);

      // Each command holds this run's lock.
      for (const command of WRITES) expect(r.notes.find((n) => n.startsWith(`at ${command} token=`))).toContain("token=same lock=1");
      // Released before the clean-up and the doctor.
      expect(r.notes.find((n) => n.startsWith("doctor "))).toBe("doctor lock=0 reason=");
      expect(fs.existsSync(lockDir)).toBe(false);

      // The originals are in the backup; the files were migrated and created, not touched in the shipped directory.
      const backups = fs.readdirSync(inTest("data/config/.backup"));
      expect(backups).toHaveLength(1);
      for (const name of OLD_FILES) expect(fs.existsSync(inTest("data/config/.backup", backups[0] ?? "", `${name}.yaml`))).toBe(true);
      expect(loads().status).toBe(0);

      // The next deploy gets the lock at once, finds nothing to do: same order, not a byte changes, backups too.
      const settled = userBytes();
      const again = await deploy();
      expect(again.status, again.out).toBe(0);
      expect(again.calls.filter((c) => WRITES.includes(c))).toEqual(WRITES);
      expect(new Set(again.sums).size).toBe(1);
      expect(userBytes()).toBe(settled);
    });

    it("deploy.sh takes the lock in one place, the preflight, and nothing writes user files before the build", () => {
      const text = fs.readFileSync(deploySh, "utf8");
      expect(text.split("\n").filter((line) => /(^|\s)releases_lock_acquire\s/.test(line) && !line.trimStart().startsWith("#"))).toHaveLength(1);
      const build = text.indexOf('step "build');
      const start4 = text.indexOf('step "config');
      expect(build).toBeGreaterThan(start4);
      const beforeBuild = text.slice(start4, build);
      expect(beforeBuild).toContain("pnpm config:init --env-only");
      // only the path for an older target, which has no write step, runs it here
      expect(beforeBuild.indexOf("config:migrate --write")).toBeGreaterThan(beforeBuild.indexOf('CONFIG_WRITE_STEP" == 0'));
    });

    it("between the gate and the writes the lock is this run's: a second run without the token cannot get it", async () => {
      existingInstall();
      const attempt = `env -u JOB_RADAR_RELEASES_LOCK_TOKEN bash -c 'source "$WORK/scripts/ops/lib/proc.sh"; source "$WORK/scripts/ops/lib/releases.sh"; releases_lock_acquire "$WORK"; echo "# second run rc=$?" >> "$DEPLOY_TEST_LOG"'`;
      const r = await deploy(ARGS, { STUB_config_migrate___write___convert_overlays_HOOK: attempt });
      expect(r.status, r.out).toBe(0);
      expect(r.notes).toContain("second run rc=1");
    });

    it("a lock held by another run: preflight stops, exit 1, the files stay", async () => {
      existingInstall();
      const before = userBytes();
      write(path.join(lockDir, "owner"), OWNER_FIXTURE);
      fs.mkdirSync(path.join(lockDir, "inflight"));
      const r = await deploy();
      expect(r.status, r.out).toBe(1);
      expect(r.calls.filter((c) => c.startsWith("pnpm "))).toEqual([]);
      expect(userBytes()).toBe(before);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(OWNER_FIXTURE);
    });
  });

  describe("before the write step", () => {
    it.each<{ phase: string; env: Record<string, string> }>([
      { phase: "install", env: { STUB_install___frozen_lockfile_EXIT: "1" } },
      { phase: "config, the compose check", env: { STUB_config_EXIT: "1" } },
      { phase: "backup", env: { DB_RUNNING: "1", STUB_backup_EXIT: "1" } },
      { phase: "build", env: { STUB_build_EXIT: "1" } },
      { phase: "release", env: { STUB_prepare_EXIT: "1" } },
      { phase: "up", env: { STUB_up_EXIT: "1" } },
      { phase: "migrate", env: { STUB_migrate_run_EXIT: "1" } },
      { phase: "worker: not changed", env: { STUB_install_HOOK: "echo 'not changed: the old worker runs'", STUB_install_EXIT: "1" } },
      { phase: "worker: rolled back", env: { STUB_install_HOOK: "echo 'rolled back: the old worker runs again'", STUB_install_EXIT: "1" } },
      { phase: "worker: rollback failed", env: { STUB_install_HOOK: "echo 'ROLLBACK FAILED: follow the commands'", STUB_install_EXIT: "1" } },
    ])("$phase fails: exit 1, not a byte changes, no writes", async ({ env }) => {
      existingInstall();
      const before = userBytes();
      const r = await deploy(ARGS, env);
      expect(r.status, r.out).toBe(1);
      assertUntouched(r, before);
      expect(r.calls).not.toContain("pnpm run doctor");
      expect(fs.existsSync(lockDir)).toBe(false);
    });

    it("the read-only step 4 on a new install writes only .env", async () => {
      fs.rmSync(inTest(".env"));
      const r = await start([deploySh, ...ARGS], { STUB_config_EXIT: "1" }, { noDatabase: true }).done;
      expect(r.status, r.out).toBe(1);
      expect(r.calls).toContain("pnpm config:init --env-only");
      expect(fs.readFileSync(inTest(".env"), "utf8")).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]+$/m);
      expect(fs.readdirSync(inTest("data/config"))).toEqual([]);
      expect(fs.readdirSync(inTest("data/profile"))).toEqual([]);
    });
  });

  describe("the start of the write step", () => {
    it.each([
      { title: "another token in the owner file", hook: `cp "$OWNER_FILE" "$LOCK/owner"`, message: "this deploy no longer holds the deploy lock", lockAfter: true },
      { title: "the lock deleted", hook: 'rm -rf "$LOCK"', message: "this deploy no longer holds the deploy lock", lockAfter: false },
      { title: "HEAD moved", hook: 'git -C "$WORK" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m moved', message: "moved", lockAfter: false },
      { title: "a tracked file changed", hook: 'echo changed >> "$WORK/package.json"', message: "changed", lockAfter: false },
    ])("$title: exit 1, no new lock, no writes, the files stay", async ({ hook, message, lockAfter }) => {
      existingInstall();
      const before = userBytes();
      const ownerFile = path.join(root, "owner-fixture");
      fs.writeFileSync(ownerFile, OWNER_FIXTURE);
      const r = await deploy(ARGS, { STUB_install_HOOK: hook, OWNER_FILE: ownerFile });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(message);
      assertUntouched(r, before);
      expect(r.calls).not.toContain("pnpm run doctor");
      expect(fs.existsSync(lockDir)).toBe(lockAfter);
      if (lockAfter) expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(OWNER_FIXTURE);
    });

    it.each<{ title: string; env: Record<string, string> }>([
      { title: "an empty token, with only the MINE flag set", env: {} },
      { title: "another token", env: { JOB_RADAR_RELEASES_LOCK_TOKEN: "f".repeat(32) } },
    ])("releases_lock_verify refuses $title", async ({ env }) => {
      write(path.join(lockDir, "owner"), OWNER_FIXTURE);
      fs.mkdirSync(path.join(lockDir, "inflight"));
      const script = 'source "$WORK/scripts/ops/lib/proc.sh"; source "$WORK/scripts/ops/lib/releases.sh"; RELEASES_LOCK_MINE=1; releases_lock_verify "$WORK"';
      const r = await start(["-c", script], env, { noDatabase: true }).done;
      expect(r.status).toBe(1);
    });

    it("a lock passed in by a calling script: the writes run under its token, and it stays that script's", async () => {
      existingInstall();
      write(path.join(lockDir, "owner"), OWNER_FIXTURE);
      fs.mkdirSync(path.join(lockDir, "inflight"));
      const r = await deploy(ARGS, { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN });
      expect(r.status, r.out).toBe(0);
      for (const command of WRITES) expect(r.notes.find((n) => n.startsWith(`at ${command} token=`))).toContain("token=same lock=1");
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(OWNER_FIXTURE);
      expect(r.notes.find((n) => n.startsWith("doctor "))).toBe("doctor lock=1 reason=");
    });
  });

  describe("the gate", () => {
    const plist = (label: string): string => path.join(root, "home/Library/LaunchAgents", `${label}.plist`);

    it.each<{ title: string; env: Record<string, string>; reason: string }>([
      { title: "no web container", env: { STUB_CONTAINERS_web: "" }, reason: "web has no container" },
      { title: "no runner container", env: { STUB_CONTAINERS_runner: "" }, reason: "runner has no container" },
      { title: "the runner not on the built image", env: { STUB_INSPECT_cid_runner: "true sha256:old" }, reason: "a runner container is not running the image this deploy built" },
      { title: "an extra old web container", env: { STUB_CONTAINERS_web: "cid-web\ncid-old", STUB_INSPECT_cid_old: "false sha256:old" }, reason: "a web container is not running the image this deploy built" },
    ])("$title: the deploy goes on, no writes, exit 2", async ({ env, reason }) => {
      existingInstall();
      const before = userBytes();
      const r = await deploy(ARGS, env);
      assertPending(r, reason, before);
      expect(r.calls).toContain("docker image prune -f");
    });

    describe("--no-ai-worker", () => {
      it("nothing installed, nobody holds the instance lock: the writes run, exit 0; no release, no install; the lock was taken in the preflight", async () => {
        existingInstall();
        const r = await deploy(NO_WORKER);
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain("deploy lock taken");
        expect(r.calls.some((c) => c.startsWith("prepare-release.sh") || c.startsWith("install-ai-worker.sh"))).toBe(false);
        expect(r.calls.filter((c) => WRITES.includes(c))).toEqual(WRITES);
        expect(r.notes).toContain(`heartbeat url=${hostDatabaseUrl}`);
        expect(fs.existsSync(lockDir)).toBe(false);
      });

      it.each([
        { title: "under the configured label", label: "com.example.worker", files: ["com.example.worker"], reason: "--no-ai-worker, and an ai-worker service is installed that this deploy did not switch" },
        { title: "under the default label", label: "com.example.worker", files: ["io.jobradar.ai-worker"], reason: "--no-ai-worker, and an ai-worker service is installed that this deploy did not switch" },
        { title: "under the old label", label: null, files: ["de.jobradar.ai-worker"], reason: "--no-ai-worker, and an ai-worker service is installed that this deploy did not switch" },
        { title: "under two labels", label: null, files: ["io.jobradar.ai-worker", "de.jobradar.ai-worker"], reason: "--no-ai-worker, and the installed ai-worker service is ambiguous" },
      ])("a service installed $title: no writes, exit 2", async ({ label, files, reason }) => {
        existingInstall();
        if (label !== null) userSchedule([[["doctor", "ai_worker_launchd_label"], label]]);
        for (const file of files) write(plist(file), "<plist/>\n");
        const before = userBytes();
        const r = await deploy(NO_WORKER);
        assertPending(r, reason, before);
        expect(r.calls.some((c) => c.startsWith("heartbeat "))).toBe(false);
      });

      it.each([
        { code: "2", reason: "--no-ai-worker, and a worker holds the instance lock" },
        { code: "1", reason: "--no-ai-worker, and the instance lock holder could not be determined" },
      ])("--lock-holder exits $code: no writes, exit 2, asked on the worker's database", async ({ code, reason }) => {
        existingInstall();
        const before = userBytes();
        const r = await deploy(NO_WORKER, { STUB_LOCK_HOLDER_EXIT: code });
        assertPending(r, reason, before);
        expect(r.notes).toContain(`heartbeat url=${hostDatabaseUrl}`);
      });
    });

    it("skipped, then a plain deploy: the writes happen, exit 0; then nothing left to do", async () => {
      existingInstall();
      write(plist("io.jobradar.ai-worker"), "<plist/>\n");
      const skipped = await deploy(NO_WORKER);
      expect(skipped.status, skipped.out).toBe(2);
      fs.rmSync(plist("io.jobradar.ai-worker"));
      const plain = await deploy();
      expect(plain.status, plain.out).toBe(0);
      expect(plain.calls.filter((c) => WRITES.includes(c))).toEqual(WRITES);
      expect(plain.sumAt(WRITES[1] ?? "")).not.toBe(plain.sumAt(WRITES[0] ?? ""));
      const settled = userBytes();
      const third = await deploy();
      expect(third.status, third.out).toBe(0);
      expect(userBytes()).toBe(settled);
    });
  });

  describe("the exit code", () => {
    it.each([
      { doctor: "0", expected: 0 },
      { doctor: "1", expected: 0 },
      { doctor: "2", expected: 2 },
      { doctor: "3", expected: 1 },
    ])("nothing pending, the doctor exits $doctor: $expected", async ({ doctor, expected }) => {
      existingInstall();
      const r = await deploy(ARGS, { STUB_run_doctor_EXIT: doctor });
      expect(r.status, r.out).toBe(expected);
    });

    it.each(["0", "1", "2", "3"])("writes pending, the doctor exits %s: 2", async (doctor) => {
      existingInstall();
      const r = await deploy(ARGS, { STUB_CONTAINERS_web: "", STUB_run_doctor_EXIT: doctor });
      assertPending(r, "web has no container");
      if (doctor === "3") expect(r.out).toContain("The doctor did not run either.");
      else expect(r.out).not.toContain("The doctor did not run either.");
    });
  });

  describe("a write fails", () => {
    const assertStopped = (r: Run, ran: number, reason: string): void => {
      assertPending(r, reason);
      expect(r.calls.filter((c) => WRITES.includes(c))).toEqual(WRITES.slice(0, ran));
      expect(r.calls).not.toContain("pnpm config:migrate --prune-backups");
      expect(r.calls).toContain("docker image prune -f");
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(loads().status).toBe(0);
    };

    it("the config write lock cannot be taken: config:migrate stops, the files stay, exit 2", async () => {
      existingInstall();
      userSchedule([[["config_writes", "lock_wait_seconds"], 1]]);
      const before = userBytes();
      const holder = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
      try {
        const [first, second] = CONFIG_WRITE_LOCK_KEY;
        await holder`select pg_advisory_lock(${first}, ${second})`;
        const r = await deploy();
        assertStopped(r, 1, "pnpm config:migrate --write --convert-overlays failed (see above)");
        expect(userBytes()).toBe(before);
      } finally {
        await holder.end({ timeout: 5 });
      }
    });

    it("the database cannot be reached: config:migrate stops, the files stay, exit 2", async () => {
      existingInstall();
      const before = userBytes();
      write(inTest(".env"), databaseEnv.replace(/^DB_HOST_PORT=.*$/m, `DB_HOST_PORT=${await unusedPort()}`));
      const r = await deploy();
      assertStopped(r, 1, "pnpm config:migrate --write --convert-overlays failed (see above)");
      expect(userBytes()).toBe(before);
    });

    it("config:init fails: the migrated files stay new, nothing else runs, exit 2", async () => {
      existingInstall();
      const r = await deploy(ARGS, { STUB_config_init_EXIT: "1" });
      assertStopped(r, 2, "pnpm config:init failed (see above)");
      expect(fs.readdirSync(inTest("data/config/.backup"))).toHaveLength(1);
    });

    it("the check after the writes still finds writes: exit 2, the backups stay", async () => {
      existingInstall();
      const old = fs.readFileSync(path.join(REPO, "tests/fixtures/config/notify.v1.yaml"), "utf8");
      const oldFile = path.join(root, "notify-old.yaml");
      fs.writeFileSync(oldFile, old);
      const r = await deploy(ARGS, { STUB_config_plan___deploy___check_HOOK: `cp "${oldFile}" "$WORK/data/config/notify.yaml"` });
      assertStopped(r, 3, "writes are still planned after the write step (see the list above)");
      expect(fs.readdirSync(inTest("data/config/.backup"))).toHaveLength(1);
    });

    it("a user edit to the next file after the plan: it is migrated from what the user saved, nothing is lost", async () => {
      existingInstall();
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      const original = (name: string): string => fs.readFileSync(path.join(REPO, `tests/fixtures/config/${name}.v1.yaml`), "utf8");
      const next = OLD_FILES.find((name) => fs.readFileSync(configFile(name), "utf8") === original(name));
      expect(next).toBeDefined();
      const name = next ?? "notify";
      fs.appendFileSync(configFile(name), "# edited while the deploy ran\n");
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(0);
      expect(fs.readFileSync(configFile(name), "utf8")).toContain("# edited while the deploy ran");
      expect(fs.readFileSync(configFile(name), "utf8")).not.toBe(`${original(name)}# edited while the deploy ran\n`);
    });

    // root ignores the permission this test relies on
    it.skipIf(process.getuid?.() === 0)("old backups that cannot be removed only warn: exit 0, not pending", async () => {
      existingInstall();
      const backups = inTest("data/config/.backup");
      const oldest = path.join(backups, "2020-01-01T00-00-00Z");
      write(path.join(oldest, "notify.yaml"), "old\n");
      for (let day = 2; day <= 9; day += 1) write(path.join(backups, `2020-01-0${day}T00-00-00Z`, "notify.yaml"), "old\n");
      fs.chmodSync(oldest, 0o555);
      try {
        const r = await deploy();
        expect(r.status, r.out).toBe(0);
        expect(r.calls).toContain("pnpm config:migrate --prune-backups");
        expect(r.out).toContain("warning: old config backups could not be removed; the deploy continues");
        expect(r.notes).toContain("doctor lock=0 reason=");
        expect(fs.existsSync(oldest)).toBe(true);
      } finally {
        fs.chmodSync(oldest, 0o755);
      }
    });
  });

  describe("signals and kills during the writes", () => {
    const mixedFiles = (): void => {
      const original = OLD_FILES.filter((name) => fs.readFileSync(configFile(name), "utf8") === fs.readFileSync(path.join(REPO, `tests/fixtures/config/${name}.v1.yaml`), "utf8"));
      expect(original).toHaveLength(1);
    };

    it.each([
      { name: "TERM", signal: "SIGTERM", code: 143 },
      { name: "INT", signal: "SIGINT", code: 130 },
      { name: "HUP", signal: "SIGHUP", code: 129 },
    ] as const)("SIG$name: the writer gets no signal and finishes in the lock, nothing later runs, exit $code; a new deploy completes", async ({ signal, code }) => {
      existingInstall();
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      mixedFiles();
      expect(await configLockHolders()).toBeGreaterThan(0);
      const writer = Number(fs.readFileSync(pauseFile(pause, "pid"), "utf8"));
      process.kill(run.pid, signal);
      await waitForSignal(run);
      expect(gone(writer)).toBe(false);
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(code);
      expect(fs.readFileSync(pauseFile(pause, "signals"), "utf8")).toBe("");
      expect(fs.readFileSync(pauseFile(pause, "exit"), "utf8")).toBe("0");
      expect(gone(writer)).toBe(true);
      expect(gone(-writer)).toBe(true);
      expect(r.calls.filter((c) => WRITES.includes(c))).toEqual(WRITES.slice(0, 1));
      expect(r.calls.some((c) => c === "pnpm run doctor" || c.includes(" prune "))).toBe(false);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(await configLockHolders()).toBe(0);
      expect(loads().status).toBe(0);

      const again = await deploy();
      expect(again.status, again.out).toBe(0);
    });

    it("SIGTERM under a calling script's lock: the owner stays, exit 143", async () => {
      existingInstall();
      write(path.join(lockDir, "owner"), OWNER_FIXTURE);
      fs.mkdirSync(path.join(lockDir, "inflight"));
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN, STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      process.kill(run.pid, "SIGTERM");
      await waitForSignal(run);
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(143);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(OWNER_FIXTURE);
    });

    it("SIGKILL of deploy.sh: exit 137, the lock and its record stay, the writer finishes on its own", async () => {
      existingInstall();
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      const writer = Number(fs.readFileSync(pauseFile(pause, "pid"), "utf8"));
      process.kill(run.pid, "SIGKILL");
      const r = await run.done;
      expect(r.status).toBe(137);
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toEqual([String(run.pid)]);
      expect(gone(writer)).toBe(false);
      letGo(pause);
      await waitFor("the writer to end", () => fs.existsSync(pauseFile(pause, "exit")));
      expect(fs.readFileSync(pauseFile(pause, "exit"), "utf8")).toBe("0");
      expect(fs.readFileSync(pauseFile(pause, "signals"), "utf8")).toBe("");
      expect(loads().status).toBe(0);
    });

    it("SIGKILL of deploy.sh under a calling script: it keeps the lock and exits 3; the writer finishes; the next deploy stops in preflight", async () => {
      existingInstall();
      const pause = newPauseDir();
      const run = start([FAKE_DEPLOY_PROD, inTest("scripts/ops/lib"), work, deploySh, ...ARGS], { STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      const writer = Number(fs.readFileSync(pauseFile(pause, "pid"), "utf8"));
      const deployPid = Number(fs.readFileSync(`${log}.deploy-pid`, "utf8"));
      process.kill(deployPid, "SIGKILL");
      const parent = await run.done;
      expect(parent.status, parent.out).toBe(3);
      expect(parent.out).toContain("a cooperative child ended without running its exit handler");
      expect(parent.out).toContain("rm -rf");
      expect(parent.notes).toContain("helper release rc=3");
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toContain(String(deployPid));
      expect(gone(writer)).toBe(false);
      letGo(pause);
      await waitFor("the writer to end", () => fs.existsSync(pauseFile(pause, "exit")));
      expect(fs.readFileSync(pauseFile(pause, "exit"), "utf8")).toBe("0");
      expect(fs.readFileSync(pauseFile(pause, "signals"), "utf8")).toBe("");
      expect(loads().status).toBe(0);

      const next = await deploy(["--settle", "0"]);
      expect(next.status, next.out).toBe(1);
      expect(next.out).not.toContain("[2/13]");
      expect(next.calls.filter((c) => c.startsWith("pnpm "))).toEqual([]);
    });

    it("a signal during the gate's last probe: no write starts, the doctor gets no reason, exit 143", async () => {
      existingInstall();
      const before = userBytes();
      const stall = newPauseDir();
      const run = start([deploySh, ...NO_WORKER], { STUB_LOCK_HOLDER_STALL: stall });
      await reachedPause(stall, run);
      process.kill(run.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      letGo(stall);
      const r = await run.done;
      expect(r.status, r.out).toBe(143);
      assertUntouched(r, before);
      expect(r.calls).not.toContain("pnpm run doctor");
      expect(r.out).not.toContain("config writes pending");
      expect(fs.existsSync(lockDir)).toBe(false);
    });
  });

  describe("the database of the writes", () => {
    it("named by .env only: no DATABASE_URL in the environment, no test mode; deploy and a direct config:init take the lock there", async () => {
      existingInstall();
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      expect(await configLockHolders()).toBeGreaterThan(0);
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(0);
      for (const command of WRITES) expect(r.notes.find((n) => n.startsWith(`at ${command} token=`))).toContain(`url=${hostDatabaseUrl}`);

      fs.rmSync(inTest("data"), { recursive: true });
      const direct = await start(["-c", "pnpm config:init"]).done;
      expect(direct.status, direct.out).toBe(0);
      expect(fs.readdirSync(inTest("data/config")).filter((f) => f.endsWith(".yaml")).length).toBeGreaterThan(0);
    });

    it.each([
      { title: ".env DATABASE_URL", env: (port: number) => `DATABASE_URL=postgres://nobody:none@127.0.0.1:${port}/none\n` },
      { title: ".env POSTGRES_* and DB_HOST_PORT", env: (port: number) => `POSTGRES_USER=nobody\nPOSTGRES_PASSWORD=none\nPOSTGRES_DB=none\nDB_HOST_PORT=${port}\n` },
    ])("DATABASE_URL in the environment wins over $title", async ({ env }) => {
      existingInstall();
      write(inTest(".env"), env(await unusedPort()));
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { DATABASE_URL: hostDatabaseUrl, STUB_PAUSE: "config_migrate___write___convert_overlays", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      expect(await configLockHolders()).toBeGreaterThan(0);
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(0);
    });

    it("a DATABASE_URL in .env means an external database: config:init --env-only leaves .env alone", async () => {
      const text = `DATABASE_URL=postgres://nobody:none@127.0.0.1:${await unusedPort()}/none\n`;
      write(inTest(".env"), text);
      const r = await start(["-c", "pnpm config:init --env-only"]).done;
      expect(r.status, r.out).toBe(0);
      expect(fs.readFileSync(inTest(".env"), "utf8")).toBe(text);
    });
  });

  describe("a first install through a gate in front of the database", () => {
    let gatePid = 0;
    let gateDir = "";
    let gatePort = 0;
    const gateFile = (name: string): string => path.join(gateDir, name);
    const UP_HOOK = () =>
      `touch "${gateFile("go")}"; for _ in $(seq 1 100); do [[ -e "${gateFile("forwarding")}" ]] && exit 0; sleep 0.1; done; exit 1`;

    beforeEach(async () => {
      gateDir = path.join(root, `gate-${++runs}`);
      fs.mkdirSync(gateDir);
      const out = fs.openSync(path.join(gateDir, "out"), "w");
      const err = fs.openSync(path.join(gateDir, "err"), "w");
      const gate = spawn(process.execPath, [TCP_GATE, "--target", target, "--dir", gateDir, "--ttl", "280"], { detached: true, stdio: ["ignore", out, err] });
      gate.unref();
      fs.closeSync(out);
      fs.closeSync(err);
      gatePid = gate.pid ?? 0;
      await waitFor("the gate to listen", () => fs.existsSync(gateFile("listening")));
      gatePort = Number(fs.readFileSync(gateFile("listening"), "utf8"));
      write(inTest(".env"), databaseEnv.replace(/^DB_HOST_PORT=.*$/m, `DB_HOST_PORT=${gatePort}`));
    });

    afterEach(async () => {
      try {
        process.kill(-gatePid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await waitFor("the gate to stop", () => gone(gatePid));
    });

    it("nothing reaches the database before the services start; then the lock is on it, the layered files exist, setup stays pending", async () => {
      const envBefore = fs.readFileSync(inTest(".env"), "utf8");
      const pause = newPauseDir();
      const run = start([deploySh, ...ARGS], { STUB_up_HOOK: UP_HOOK(), STUB_PAUSE: "config_init", PAUSE_DIR: pause });
      await reachedPause(pause, run);
      expect(fs.readFileSync(gateFile("pre-up-count"), "utf8")).toBe("0");
      expect(await configLockHolders()).toBeGreaterThan(0);
      letGo(pause);
      const r = await run.done;
      expect(r.status, r.out).toBe(0);

      const config = fs.readdirSync(inTest("data/config")).filter((f) => f.endsWith(".yaml"));
      expect(config.length).toBeGreaterThan(0);
      expect(config).not.toContain("setup.yaml");
      expect(config).not.toContain("language.yaml");
      expect(fs.readdirSync(inTest("data/profile")).filter((f) => f.endsWith(".yaml")).length).toBeGreaterThan(0);
      expect(fs.readFileSync(inTest(".env"), "utf8")).toBe(envBefore);

      write(inTest("scripts/read-setup-state.ts"), 'import { readSetupState } from "@/lib/setup/state";\nconsole.log(JSON.stringify({ pending: readSetupState().pending }));\n');
      const state = spawnSync(process.execPath, ["--import", "tsx", "scripts/read-setup-state.ts"], { cwd: work, env: childEnv({}), encoding: "utf8" });
      fs.rmSync(inTest("scripts/read-setup-state.ts"));
      expect(state.stdout, state.stderr).toContain('"pending":true');
    });

    it("the gate counts: a connection before the services start shows up", async () => {
      const connect = `node -e 'require("node:net").connect(${gatePort}, "127.0.0.1").on("close", () => process.exit(0)).on("error", () => process.exit(0))'`;
      const r = await deploy(ARGS, { STUB_install___frozen_lockfile_HOOK: connect, STUB_up_HOOK: UP_HOOK() });
      expect(r.status, r.out).toBe(0);
      expect(fs.readFileSync(gateFile("pre-up-count"), "utf8")).toBe("1");
    });
  });
});
