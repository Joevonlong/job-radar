// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/deploy.sh, run for real against a throw-away git repository and stub `docker` / `pnpm`
 * commands that only log what they were asked to do. Nothing here touches the real stack.
 *
 * The log ($DEPLOY_TEST_LOG) holds the stub calls ("docker …", "pnpm …", "backup.sh …") and, prefixed with "#", events:
 * every call of releases_lock_release ("# release mine=<0|1>", from a logging wrapper appended to the copied
 * releases.sh), and the lines of tests/fixtures/ops/blocking-stub.sh and fake-deploy-prod.sh.
 */
const repoRoot = path.resolve(import.meta.dirname, "../..");
const realScript = path.join(repoRoot, "scripts/ops/deploy.sh");
const realLib = path.join(repoRoot, "scripts/ops/lib");
const blockingStub = path.join(repoRoot, "tests/fixtures/ops/blocking-stub.sh");
const fakeWrapper = path.join(repoRoot, "tests/fixtures/ops/fake-deploy-prod.sh");
const ownerFixture = fs.readFileSync(path.join(repoRoot, "tests/fixtures/ops/lock-owner-wrapper.txt"), "utf8");
const FIXTURE_TOKEN = "0123456789abcdef0123456789abcdef";
const PS_COMMAND =
  "ps -A -o pid,ppid,pgid,etime,command | grep -E '[d]ocker compose|[p]npm|[m]igrate|[c]onfig[:-]|[o]ps:drain|[p]repare-release|[i]nstall-ai-worker|[l]aunchctl|[s]ystemctl'";

let tmp = "";
let work = "";
let realWork = "";
let origin = "";
let stubs = "";
let log = "";
let lockDir = "";
let buildDir = "";

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

const LOGGING_STUB = (name: string): string => `#!/usr/bin/env bash\necho "${name} $*" >> "$DEPLOY_TEST_LOG"\n`;
// prepare-release.sh / install-ai-worker.sh stubs: log, run <VAR>_HOOK, exit with <VAR>_EXIT (VAR = PREPARE or INSTALL).
// <VAR>_EXEC=1 execs the hook instead, so that the hook is the process deploy.sh started (same PID, group leader).
const STEP_STUB = (name: string, v: string): string =>
  `${LOGGING_STUB(name)}if [[ -n "\${${v}_HOOK:-}" && "\${${v}_EXEC:-}" == 1 ]]; then exec bash -c "$${v}_HOOK"; fi\n` +
  `if [[ -n "\${${v}_HOOK:-}" ]]; then bash -c "$${v}_HOOK"; fi\nexit "\${${v}_EXIT:-0}"\n`;

// Appended to the copied releases.sh: logs every release call, then runs the real one.
const RELEASE_LOGGER = `
# test only: log every call of releases_lock_release
eval "$(declare -f releases_lock_release | sed '1s/^releases_lock_release/test_real_releases_lock_release/')"
releases_lock_release() { echo "# release mine=$RELEASES_LOCK_MINE" >> "\${DEPLOY_TEST_LOG:-/dev/null}"; test_real_releases_lock_release "$@"; }
# test only: TEST_HALF_MADE_LOCK=1 makes creating inflight/ fail and then the removal of .lock fail too (a half-made lock)
if [[ -n "\${TEST_HALF_MADE_LOCK:-}" ]]; then
  mkdir() { if [[ "\${1:-}" == */.lock/inflight ]]; then echo "mkdir: No space left on device" >&2; return 1; fi; command mkdir "$@"; }
  rmdir() { if [[ "\${1:-}" == */.lock ]]; then return 1; fi; command rmdir "$@"; }
fi
# test only: log every liveness check with the in-flight records present at that moment
eval "$(declare -f releases_pid_alive | sed '1s/^releases_pid_alive/test_real_releases_pid_alive/')"
releases_pid_alive() { echo "# pid_alive $1 inflight=$(ls "\${LOCK:-/nonexistent}/inflight" 2>/dev/null | tr '\\n' ',')" >> "\${DEPLOY_TEST_LOG:-/dev/null}"; test_real_releases_pid_alive "$@"; }
`;

// Hook snippets for the stubs (run with bash -c; DEPLOY_PID is deploy.sh's PID, WORK the checkout, LOCK the lock directory).
const GIT_T = 'git -C "$WORK" -c user.name=t -c user.email=t@example.com';
const MOVE_HEAD = `${GIT_T} commit -q --allow-empty -m moved`;
const COMMIT_LATE_FILE = `echo late > "$WORK/LATE" && ${GIT_T} add LATE && ${GIT_T} commit -q -m late`;
const TOUCH_TRACKED = 'echo changed >> "$WORK/src/app.ts"';
const BLOCK = (name: string): string => `BLOCK_NAME=${name} bash "${blockingStub}"`;
const CORRUPT_INDEX = 'printf "not an index" > "$WORK/.git/index"';
const ADD_OTHER_RECORD = `printf 'script=install-ai-worker.sh\\npid=1\\nstarted=1\\n' > "$LOCK/inflight/1"`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  origin = path.join(tmp, "origin.git");
  work = path.join(tmp, "work");
  stubs = path.join(tmp, "bin");
  log = path.join(tmp, "calls.log");

  git(tmp, "init", "--bare", "--initial-branch=main", origin);
  git(tmp, "clone", origin, work);
  realWork = fs.realpathSync(work);
  lockDir = path.join(realWork, "data/releases/ai-worker/.lock");
  buildDir = path.join(realWork, "data/build");
  write(path.join(work, "scripts/ops/deploy.sh"), fs.readFileSync(realScript, "utf8"), 0o755);
  write(path.join(work, "scripts/ops/lib/proc.sh"), fs.readFileSync(path.join(realLib, "proc.sh"), "utf8"));
  write(path.join(work, "scripts/ops/lib/releases.sh"), fs.readFileSync(path.join(realLib, "releases.sh"), "utf8") + RELEASE_LOGGER);
  write(path.join(work, "scripts/ops/lib/deploy-result.sh"), fs.readFileSync(path.join(realLib, "deploy-result.sh"), "utf8"));
  write(path.join(work, "scripts/ops/backup.sh"), LOGGING_STUB("backup.sh"), 0o755);
  // the install stub carries the capability line deploy.sh --ref looks for in the target commit
  write(path.join(work, "scripts/ops/install-ai-worker.sh"), `${STEP_STUB("install-ai-worker.sh", "INSTALL")}# capability: ai-worker-release-dir\n`, 0o755);
  write(path.join(work, "scripts/ops/prepare-release.sh"), STEP_STUB("prepare-release.sh", "PREPARE"), 0o755);
  write(path.join(work, "package.json"), '{"name":"job-radar"}\n');
  write(path.join(work, "config/schedule.yaml"), "timezone: Europe/Berlin\ndoctor:\n  compose_project: radar-test\n  web_url: http://127.0.0.1:3000\n");
  write(path.join(work, "src/app.ts"), "export {};\n");
  write(path.join(work, "bin/tool.sh"), "echo tool\n", 0o644);
  write(path.join(work, ".gitignore"), "*.local.yaml\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "main");

  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  // git wrapper: logs to $DEPLOY_TEST_LOG.git; GIT_FAIL_ARCHIVE=1 makes `git … archive …` exit 1 (tar still ends normally).
  write(
    path.join(stubs, "git"),
    `#!/usr/bin/env bash
echo "git $*" >> "$DEPLOY_TEST_LOG.git"
if [[ "\${GIT_FAIL_ARCHIVE:-}" == 1 && " $* " == *" archive "* ]]; then echo "fatal: archive failed (test)" >&2; exit 1; fi
# GIT_TARGET_HOOK runs once, right after the first plain \`rev-parse HEAD\` (the one that fixes TARGET).
if [[ -n "\${GIT_TARGET_HOOK:-}" && "$*" == *" rev-parse HEAD" && ! -e "$DEPLOY_TEST_LOG.hooked" ]]; then
  "${realGit}" "$@"; rc=$?; : > "$DEPLOY_TEST_LOG.hooked"; bash -c "$GIT_TARGET_HOOK"; exit $rc
fi
exec "${realGit}" "$@"
`,
    0o755,
  );
  // stub docker: `info` ok, `compose ... ps --status running --services` lists db when DB_RUNNING=1, everything else is logged.
  // `compose ... build` records JOB_RADAR_BUILD_CONTEXT in $DEPLOY_TEST_LOG.ctx, runs BUILD_HOOK, then copies the context to
  // DEPLOY_TEST_CTX_COPY (modes and links kept).
  write(
    path.join(stubs, "docker"),
    `#!/usr/bin/env bash
echo "docker $*" >> "$DEPLOY_TEST_LOG"
export DEPLOY_PID=$PPID
[[ "$1" == "info" ]] && exit \${DOCKER_INFO_EXIT:-0}
if [[ "$*" == *"ps --status running --services"* ]]; then [[ "\${DB_RUNNING:-0}" == "1" ]] && echo db; exit 0; fi
if [[ "$1" == compose && "\${*: -1}" == build ]]; then
  echo "\${JOB_RADAR_BUILD_CONTEXT:-<unset>}" >> "$DEPLOY_TEST_LOG.ctx"
  if [[ -n "\${BUILD_HOOK:-}" ]]; then bash -c "$BUILD_HOOK" || exit $?; fi
  if [[ -n "\${DEPLOY_TEST_CTX_COPY:-}" ]]; then rm -rf "$DEPLOY_TEST_CTX_COPY"; cp -Rp "$JOB_RADAR_BUILD_CONTEXT" "$DEPLOY_TEST_CTX_COPY"; fi
  exit \${BUILD_EXIT:-0}
fi
if [[ "$*" == *" up "* ]]; then
  echo "\${JOB_RADAR_BUILD_CONTEXT:-<unset>}" >> "$DEPLOY_TEST_LOG.ctx"
  if [[ -n "\${UP_HOOK:-}" ]]; then bash -c "$UP_HOOK"; fi
  exit \${UP_EXIT:-0}
fi
if [[ "$*" == *" prune "* ]]; then
  if [[ -n "\${PRUNE_HOOK:-}" ]]; then bash -c "$PRUNE_HOOK"; fi
  if [[ -n "\${PRUNE_EXIT:-}" ]]; then echo "unknown flag: --max-used-space" >&2; exit "$PRUNE_EXIT"; fi
  printf 'deleted sha256:aaa\\nTotal:\\t1.2GB\\n'; exit 0
fi
exit 0
`,
    0o755,
  );
  // stub pnpm: logs, runs PNPM_<script>_HOOK, exits with PNPM_<script>_EXIT (e.g. PNPM_doctor_EXIT=2)
  write(
    path.join(stubs, "pnpm"),
    `#!/usr/bin/env bash
echo "pnpm $*" >> "$DEPLOY_TEST_LOG"
export DEPLOY_PID=$PPID
name="\${*: -1}"; name="\${name//:/_}"; name="\${name//-/_}"
hook="PNPM_\${name}_HOOK"
if [[ -n "\${!hook:-}" ]]; then bash -c "\${!hook}" || exit $?; fi
var="PNPM_\${name}_EXIT"
exit \${!var:-0}
`,
    0o755,
  );
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Run = { status: number | null; out: string; calls: string[]; events: string[]; contexts: string[]; gitCalls: string[] };

const readLines = (file: string): string[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

function resetLogs(): void {
  for (const f of [log, `${log}.ctx`, `${log}.git`]) fs.writeFileSync(f, "");
  fs.rmSync(`${log}.hooked`, { force: true });
}

function collect(status: number | null, out: string): Run {
  const events = readLines(log);
  return { status, out, events, calls: events.filter((l) => !l.startsWith("#")), contexts: readLines(`${log}.ctx`), gitCalls: readLines(`${log}.git`) };
}

function deployEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base = { ...process.env };
  delete base.JOB_RADAR_RELEASES_LOCK_TOKEN;
  delete base.JOB_RADAR_DEPLOY_EXPECT_SHA;
  return {
    ...base,
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
    DEPLOY_TEST_LOG: log,
    WORK: realWork,
    LOCK: lockDir,
    BLOCK_LOCK: lockDir,
    BLOCK_CONTINUE: path.join(tmp, "continue"),
    ...env,
  };
}

function deploy(args: string[], env: Record<string, string> = {}): Run {
  resetLogs();
  const result = spawnSync("bash", [path.join(work, "scripts/ops/deploy.sh"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: deployEnv(env),
    timeout: 60_000,
  });
  return collect(result.status, `${result.stdout}${result.stderr}`);
}

// deploy.sh in its own process group (spawn detached), so a test can signal the group like a terminal does.
function startDeploy(command: string[], env: Record<string, string> = {}): { pid: number; done: Promise<Run> } {
  resetLogs();
  fs.rmSync(path.join(tmp, "continue"), { force: true });
  const child = spawn("bash", command, { cwd: work, env: deployEnv(env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const done = new Promise<Run>((resolve) => child.on("close", (code, signal) => resolve(collect(code ?? (signal ? -1 : null), out))));
  return { pid: child.pid ?? -1, done };
}

async function waitFor(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const logHas = (text: string): boolean => readLines(log).some((l) => l.includes(text));
const release = (): void => fs.writeFileSync(path.join(tmp, "continue"), "");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const buildContexts = (): string[] => (fs.existsSync(buildDir) ? fs.readdirSync(buildDir).sort() : []);
const head = (): string => git(work, "rev-parse", "HEAD");

// After a test that moved HEAD, changed files or left a lock: back to the committed state.
function restore(commit: string): void {
  git(work, "checkout", "-q", "main");
  git(work, "reset", "-q", "--hard", commit);
  fs.rmSync(path.join(realWork, "data/releases"), { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
}

// After a test that damaged the index: rebuild it from HEAD.
function repairIndex(): void {
  fs.rmSync(path.join(work, ".git/index"), { force: true });
  git(work, "reset", "-q");
}

// A sorted listing of a tree: path, permission bits, link target.
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) out.push(`${r} link ${fs.readlinkSync(path.join(dir, r))}`);
      else if (st.isDirectory()) {
        out.push(`${r}/ ${mode}`);
        walk(r);
      } else out.push(`${r} ${mode}`);
    }
  };
  walk("");
  return out.sort();
}

function archiveOf(commit: string): string {
  const dest = fs.mkdtempSync(path.join(tmp, "expected-"));
  const r = spawnSync("bash", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "_", work, commit, dest]);
  if (r.status !== 0) throw new Error("git archive failed");
  return dest;
}

const deadPid = (): number => Number(spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());

function placeLock(owner: string, records: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(lockDir, "inflight"), { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), owner);
  for (const [name, content] of Object.entries(records)) fs.writeFileSync(path.join(lockDir, "inflight", name), content);
}

describe("scripts/ops/deploy.sh", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", realScript]).status).toBe(0);
  });

  it("--help prints the usage without doing anything", () => {
    const r = deploy(["--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("scripts/ops/deploy.sh [--dry-run]");
    expect(r.calls).toEqual([]);
  });

  it("rejects unknown and incomplete arguments", () => {
    expect(deploy(["--nope"])).toMatchObject({ status: 1, out: expect.stringContaining("unknown argument: --nope") });
    expect(deploy(["--branch"]).out).toContain("--branch needs a value");
    expect(deploy(["--settle", "x"]).out).toContain("needs a whole number");
  });

  it("--dry-run prints the twelve steps in order and runs no docker, pnpm or script", () => {
    const r = deploy(["--dry-run"], { DB_RUNNING: "1" });
    expect(r.status).toBe(0);
    const steps = [...r.out.matchAll(/^\[(\d+)\/12\] (\S+?):/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual(["1 preflight", "2 pull", "3 install", "4 config", "5 backup", "6 build", "7 release", "8 up", "9 migrate", "10 ai-worker", "11 prune", "12 doctor"]);
    for (const line of [
      "$ git fetch origin main",
      "$ git merge --ff-only origin/main",
      "$ pnpm install --frozen-lockfile",
      "$ mkdir -p data/config data/profile data/backups data/exports",
      "$ pnpm config:init",
      "$ pnpm config:migrate --write",
      "$ pnpm config:check",
      "$ docker compose -p radar-test config -q",
      "$ scripts/ops/backup.sh --label pre-deploy",
      "$ git archive ",
      "$ docker compose -p radar-test build",
      "$ scripts/ops/prepare-release.sh ",
      "$ pnpm ops:drain",
      "$ docker compose -p radar-test up -d --wait --wait-timeout 300",
      "$ pnpm migrate:run",
      "$ scripts/ops/install-ai-worker.sh --release ",
      "the deploy lock is released here, and the build context removed",
      "$ docker builder prune -f --max-used-space 5gb",
      "$ docker image prune -f",
      "$ pnpm run doctor",
    ]) {
      expect(r.out, line).toContain(line);
    }
    expect(r.out).toContain("dry-run finished: nothing was changed");
    // only read-only probes: docker info and the `ps` that asks whether the db runs
    expect(r.calls.every((c) => c === "docker info" || c.includes("ps --status running --services"))).toBe(true);
    // a dry run takes no lock and builds nothing
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(buildContexts()).toEqual([]);
  });

  it("--dry-run shows what would stop a real run, and still prints every step", () => {
    git(work, "checkout", "-q", "-B", "feature");
    try {
      const r = deploy(["--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.out).toContain("a real run would stop here: the current branch is feature, not main");
      expect(r.out).toContain("[12/12] doctor");
    } finally {
      git(work, "checkout", "-q", "main");
    }
  });

  it("--dry-run honours --skip-pull, --no-backup, --no-ai-worker, --wait-timeout", () => {
    const r = deploy(["--dry-run", "--skip-pull", "--no-backup", "--no-ai-worker", "--wait-timeout", "45", "--settle", "3"], { DB_RUNNING: "1" });
    expect(r.out).toContain("--skip-pull: git is left alone");
    expect(r.out).not.toContain("git fetch");
    expect(r.out).toContain("--no-backup: skipped");
    expect(r.out).toContain("--no-ai-worker: skipped");
    expect(r.out).toContain("up -d --wait --wait-timeout 45");
    expect(r.out).toContain("sleep 3");
  });

  it("refuses to deploy from another branch or a dirty tree, before anything is changed", () => {
    git(work, "checkout", "-q", "-B", "feature");
    const wrongBranch = deploy([]);
    git(work, "checkout", "-q", "main");
    expect(wrongBranch.status).toBe(1);
    expect(wrongBranch.out).toContain('step 2/12 "pull: update the code" failed: the current branch is feature, not main');
    expect(wrongBranch.calls).toEqual(["docker info"]);

    write(path.join(work, "scripts/ops/backup.sh"), `${LOGGING_STUB("backup.sh")}# changed\n`, 0o755);
    try {
      // in every mode, --skip-pull too: the images are built from the commit
      for (const args of [[], ["--skip-pull"]]) {
        const dirty = deploy(args);
        expect(dirty.status).toBe(1);
        expect(dirty.out).toContain('step 1/12 "preflight: terminal, deploy lock, tools, Docker, clean checkout, external volume" failed: there are uncommitted changes');
        expect(dirty.calls).toEqual(["docker info"]);
        expect(fs.existsSync(lockDir)).toBe(false);
      }
    } finally {
      git(work, "checkout", "--", "scripts/ops/backup.sh");
    }
  });

  it("a full run: fast-forwards, then installs, checks, backs up, builds, starts, migrates, installs the worker, releases the lock, cleans up and runs the doctor, in that order", () => {
    // someone else pushes a commit to origin/main
    const other = path.join(tmp, "other");
    git(tmp, "clone", origin, other);
    write(path.join(other, "NEWFILE"), "x\n");
    git(other, "add", ".");
    git(other, "commit", "-m", "upstream");
    git(other, "push", "origin", "main");
    const before = git(work, "rev-parse", "HEAD");

    const r = deploy(["--settle", "0"], { DB_RUNNING: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Deploy complete, doctor passed everything");
    expect(git(work, "rev-parse", "HEAD")).not.toBe(before);
    expect(fs.existsSync(path.join(work, "NEWFILE"))).toBe(true);
    expect(r.calls.filter((c) => !c.startsWith("docker compose -p radar-test ps"))).toEqual([
      "docker info",
      "pnpm install --frozen-lockfile",
      "pnpm config:init",
      "pnpm config:migrate --write",
      "pnpm config:check",
      "docker compose -p radar-test config -q",
      "backup.sh --label pre-deploy",
      "docker compose -p radar-test build",
      `prepare-release.sh ${head()} --root ${realWork}`,
      "pnpm ops:drain",
      "docker compose -p radar-test up -d --wait --wait-timeout 300",
      "pnpm migrate:run",
      `install-ai-worker.sh --release ${realWork}/data/releases/ai-worker/${head()} --root ${realWork}`,
      "docker builder prune -f --max-used-space 5gb",
      "docker image prune -f",
      "pnpm run doctor",
    ]);
    // the lock is released once, after the ai-worker and before the clean-up (which runs outside it); the context is gone
    const events = r.events.filter((c) => !c.startsWith("docker compose -p radar-test ps"));
    expect(events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
    expect(events.indexOf("# release mine=1")).toBe(events.findIndex((e) => e.startsWith("install-ai-worker.sh")) + 1);
    expect(r.out).toContain("deploy lock released, build context removed");
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(buildContexts()).toEqual([]);
    expect(r.out).toContain("Total:\t1.2GB");
    expect(fs.existsSync(path.join(work, "data/backups"))).toBe(true);
    expect(fs.existsSync(path.join(work, "data/profile"))).toBe(true);
    expect(fs.existsSync(path.join(work, "data/config"))).toBe(true);
    // never destructive: no `down -v`, no volume prune, no `image prune -a` / `system prune`
    expect(r.calls.join("\n")).not.toMatch(/\bdown\b|-v\b|volume|--volumes|\s-a\b|--all|system prune/);
  });

  it("is idempotent: running it again with nothing new does the same steps and succeeds", () => {
    const again = deploy(["--settle", "0"], { DB_RUNNING: "1" });
    expect(again.status).toBe(0);
    expect(again.out).toContain("Deploy complete");
  });

  it("--no-prune skips the Docker clean-up; --dry-run only prints it", () => {
    const skipped = deploy(["--settle", "0", "--no-prune"], { DB_RUNNING: "1" });
    expect(skipped.status).toBe(0);
    expect(skipped.out).toContain("--no-prune: skipped");
    expect(skipped.calls.some((c) => c.includes("prune"))).toBe(false);
    const dry = deploy(["--dry-run"], { DB_RUNNING: "1" });
    expect(dry.out).toContain("$ docker builder prune -f --max-used-space 5gb");
    expect(dry.calls.some((c) => c.includes("prune"))).toBe(false);
  });

  it("a failing clean-up only warns: the deploy carries on to the doctor", () => {
    const r = deploy(["--settle", "0"], { DB_RUNNING: "1", PRUNE_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("warning: clean-up failed (the deploy continues): unknown flag: --max-used-space");
    expect(r.calls).toContain("pnpm migrate:run");
    expect(r.calls).toContain("pnpm run doctor");
  });

  it("follows schedule.yaml deploy: keep 0 prunes all unused cache, switches turn each part off", () => {
    // the user layer (data/config wins over config/); a change to the tracked config/ would make the checkout dirty
    const original = fs.readFileSync(path.join(work, "config/schedule.yaml"), "utf8");
    const schedule = path.join(work, "data/config/schedule.yaml");
    fs.mkdirSync(path.dirname(schedule), { recursive: true });
    try {
      fs.writeFileSync(schedule, `${original}deploy:\n  prune_build_cache: true\n  build_cache_keep_gb: 0  # all\n  prune_dangling_images: false\n`);
      const all = deploy(["--settle", "0", "--skip-pull"], { DB_RUNNING: "1" });
      expect(all.calls.filter((c) => c.includes("prune"))).toEqual(["docker builder prune -f"]);
      expect(all.out).toContain("deploy.prune_dangling_images is not true: dangling images are not removed");

      fs.writeFileSync(schedule, `${original}deploy:\n  prune_build_cache: false\n  build_cache_keep_gb: 12\n  prune_dangling_images: true\n`);
      const imagesOnly = deploy(["--settle", "0", "--skip-pull"], { DB_RUNNING: "1" });
      expect(imagesOnly.calls.filter((c) => c.includes("prune"))).toEqual(["docker image prune -f"]);

      fs.writeFileSync(schedule, `${original}deploy:\n  build_cache_keep_gb: 12\n`);
      expect(deploy(["--settle", "0", "--skip-pull"], { DB_RUNNING: "1" }).calls).toContain("docker builder prune -f --max-used-space 12gb");
    } finally {
      fs.rmSync(schedule, { force: true });
    }
  });

  it("waits for a running cycle before recreating the containers; --drain-timeout passes the limit, --no-drain skips it", () => {
    const r = deploy(["--settle", "0", "--skip-pull", "--drain-timeout", "60"], { DB_RUNNING: "1" });
    expect(r.status).toBe(0);
    const calls = r.calls.filter((c) => !c.startsWith("docker compose -p radar-test ps"));
    expect(calls.indexOf("pnpm ops:drain --timeout 60")).toBeGreaterThan(calls.indexOf("docker compose -p radar-test build"));
    expect(calls.indexOf("pnpm ops:drain --timeout 60")).toBeLessThan(calls.indexOf("docker compose -p radar-test up -d --wait --wait-timeout 300"));
    expect(r.out).toContain("running AI requests are not waited for, they are queued again after the restart");
    expect(r.out).toContain("an AI request it is running (for example run_ai) goes back to the queue");

    const skipped = deploy(["--settle", "0", "--skip-pull", "--no-drain"], { DB_RUNNING: "1" });
    expect(skipped.status).toBe(0);
    expect(skipped.out).toContain("--no-drain: not waiting for a running cycle");
    expect(skipped.calls.some((c) => c.startsWith("pnpm ops:drain"))).toBe(false);

    expect(deploy(["--drain-timeout", "soon"]).out).toContain("needs a whole number");
  });

  it("a cycle still running after the drain timeout only warns: the deploy goes on", () => {
    const r = deploy(["--settle", "0", "--skip-pull"], { DB_RUNNING: "1", PNPM_ops_drain_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("warning: a cycle is still running after the wait; the deploy continues");
    expect(r.calls).toContain("docker compose -p radar-test up -d --wait --wait-timeout 300");
    expect(r.calls).toContain("pnpm run doctor");
    const unknown = deploy(["--settle", "0", "--skip-pull"], { DB_RUNNING: "1", PNPM_ops_drain_EXIT: "2" });
    expect(unknown.status).toBe(0);
    expect(unknown.out).toContain("warning: could not check for a running cycle (pnpm ops:drain exited with 2)");
  });

  it("--dry-run prints the drain without running it", () => {
    const r = deploy(["--dry-run", "--skip-pull"], { DB_RUNNING: "1" });
    expect(r.out).toContain("$ pnpm ops:drain");
    expect(r.calls.some((c) => c.startsWith("pnpm"))).toBe(false);
  });

  it("skips the backup on a first deploy (db not running)", () => {
    const r = deploy(["--settle", "0"], { DB_RUNNING: "0" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("db is not running yet (first deploy)");
    expect(r.calls.some((c) => c.startsWith("backup.sh"))).toBe(false);
  });

  it("stops at the first failing step and says why (services never turn healthy)", () => {
    const r = deploy(["--settle", "0"], { DB_RUNNING: "1", UP_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain('step 8/12 "up: start and wait until healthy (at most 300 s)" failed: not all services became healthy within 300 s');
    expect(r.out).toContain("What to do: docker compose -p radar-test logs --tail 100");
    expect(r.calls.some((c) => c.startsWith("pnpm migrate:run") || c.startsWith("install-ai-worker.sh") || c === "pnpm run doctor")).toBe(false);
  });

  it("stops when config:check fails, before the build", () => {
    const r = deploy(["--settle", "0"], { PNPM_config_check_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("step 4/12");
    expect(r.out).toContain("command failed: pnpm config:check");
    expect(r.calls.some((c) => c.includes(" build"))).toBe(false);
  });

  it("stops when the config migration fails, before the check and the build", () => {
    const r = deploy(["--settle", "0"], { PNPM___write_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("command failed: pnpm config:migrate --write");
    expect(r.calls).not.toContain("pnpm config:check");
    expect(r.calls.some((c) => c.includes(" build"))).toBe(false);
  });

  it("says when the user config directory is filled for the first time, and reads schedule.yaml from it first", () => {
    const userDir = path.join(work, "data/config");
    fs.rmSync(userDir, { recursive: true, force: true });
    const first = deploy(["--dry-run", "--skip-pull"]);
    expect(first.out).toContain("user config directory data/config is empty (first layered deploy)");
    expect(first.out).toContain("$ docker compose -p radar-test config -q");
    try {
      // the user's schedule.yaml wins over the shipped one (the compose project name, the prune settings)
      write(path.join(userDir, "schedule.yaml"), "timezone: Europe/Berlin\ndoctor:\n  compose_project: radar-user\ndeploy:\n  build_cache_keep_gb: 7\n");
      const later = deploy(["--dry-run", "--skip-pull"], { DB_RUNNING: "1" });
      expect(later.out).toContain("user config directory data/config already has files: only missing ones are added");
      expect(later.out).toContain("project: radar-user");
      expect(later.out).toContain("$ docker compose -p radar-user build");
      expect(later.out).toContain("$ docker builder prune -f --max-used-space 7gb");
      // data/ is not tracked: the checkout stays clean for the next pull
      expect(git(work, "status", "--porcelain", "--untracked-files=no")).toBe("");
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("the external-volume guard is off unless JOB_RADAR_DEPLOY_VOLUME is set, and then names the doubly mounted volume", () => {
    const volume = path.join(fs.realpathSync(tmp), "vol");
    fs.mkdirSync(`${volume} 1`, { recursive: true });
    try {
      expect(deploy(["--dry-run"]).out).not.toContain("the external volume is mounted twice");
      const guarded = deploy(["--dry-run"], { JOB_RADAR_DEPLOY_VOLUME: volume });
      expect(guarded.status).toBe(0);
      expect(guarded.out).toContain(`a real run would stop here: ${volume} 1 exists: the external volume is mounted twice`);
      const real = deploy([], { JOB_RADAR_DEPLOY_VOLUME: volume });
      expect(real.status).toBe(1);
      expect(real.out).toContain("step 1/12");
    } finally {
      fs.rmSync(`${volume} 1`, { recursive: true, force: true });
    }
  });

  it("stops when Docker is not running", () => {
    const r = deploy(["--settle", "0"], { DOCKER_INFO_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("step 1/12");
    expect(r.out).toContain("Docker is not running");
  });

  it("maps the doctor's verdict: warnings are fine, failures give exit code 2, a crashed doctor is a failed step", () => {
    expect(deploy(["--settle", "0"], { PNPM_doctor_EXIT: "1" })).toMatchObject({ status: 0, out: expect.stringContaining("The doctor reported warnings") });
    const failed = deploy(["--settle", "0"], { PNPM_doctor_EXIT: "2" });
    expect(failed.status).toBe(2);
    expect(failed.out).toContain("the doctor reported problems");
    const crashed = deploy(["--settle", "0"], { PNPM_doctor_EXIT: "3" });
    expect(crashed.status).toBe(1);
    expect(crashed.out).toContain("the doctor itself could not run");
    expect(deploy(["--settle", "0"], { PNPM_doctor_EXIT: "0" }).status).toBe(0);
    expect(deploy(["--settle", "0"], { PNPM_doctor_EXIT: "127" }).status).toBe(1);
  });

  it("the worker switch fails (rolled back:): exit 1 with the next steps, the lock is released, no prune, no doctor", () => {
    const r = deploy(["--settle", "0"], { INSTALL_EXIT: "1", INSTALL_HOOK: 'echo "rolled back: install-ai-worker: test" >&2' });
    expect(r.status).toBe(1);
    expect(r.out).toContain("the ai-worker switch failed (install-ai-worker.sh exited 1)");
    expect(r.out).toContain("rolled back: install-ai-worker: test");
    expect(r.calls.some((c) => c.includes(" prune ") || c === "pnpm run doctor")).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("prepare and install run under the deploy's lock with its token, for the target commit; the lock is gone at the prune", () => {
    const seen = 'echo "# $0 lock=$([[ -d "$LOCK" ]] && echo 1 || echo 0) token=$([[ -n "$JOB_RADAR_RELEASES_LOCK_TOKEN" && "$(sed -n s/^token=//p "$LOCK/owner")" == "$JOB_RADAR_RELEASES_LOCK_TOKEN" ]] && echo same || echo other)" >> "$DEPLOY_TEST_LOG"';
    const r = deploy(["--settle", "0"], {
      PREPARE_HOOK: seen.replace("$0", "prepare"),
      INSTALL_HOOK: seen.replace("$0", "install"),
      PRUNE_HOOK: 'echo "# prune lock=$([[ -d "$LOCK" ]] && echo 1 || echo 0)" >> "$DEPLOY_TEST_LOG"',
    });
    expect(r.status, r.out).toBe(0);
    expect(r.events).toEqual(expect.arrayContaining(["# prepare lock=1 token=same", "# install lock=1 token=same", "# prune lock=0"]));
    expect(r.calls).toContain(`prepare-release.sh ${head()} --root ${realWork}`);
    expect(r.calls).toContain(`install-ai-worker.sh --release ${realWork}/data/releases/ai-worker/${head()} --root ${realWork}`);
  });

  it("--no-ai-worker: no prepare, no install; the lock is still taken in preflight and released before the prune", () => {
    const r = deploy(["--settle", "0", "--no-ai-worker"], { PRUNE_HOOK: 'echo "# prune lock=$([[ -d "$LOCK" ]] && echo 1 || echo 0)" >> "$DEPLOY_TEST_LOG"' });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.some((c) => c.startsWith("prepare-release.sh") || c.startsWith("install-ai-worker.sh"))).toBe(false);
    expect(r.events).toContain("# release mine=1");
    expect(r.events).toContain("# prune lock=0");
    placeLock(ownerFixture);
    try {
      const held = deploy(["--settle", "0", "--no-ai-worker"]);
      expect(held.status).toBe(1);
      expect(held.calls.filter((c) => c !== "docker info")).toEqual([]);
    } finally {
      fs.rmSync(path.join(realWork, "data/releases"), { recursive: true, force: true });
    }
  });

  it("HEAD moves during the migration: the check before the ai-worker step stops it, install never runs", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_migrate_run_HOOK: MOVE_HEAD });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 10/12 "ai-worker');
      expect(r.out).toContain("checkout moved during deploy");
      expect(r.calls.some((c) => c.startsWith("install-ai-worker.sh"))).toBe(false);
    } finally {
      restore(base);
    }
  });
  describe("--ref", () => {
    it("rejects a missing or option-like value", () => {
      expect(deploy(["--ref"]).out).toContain("--ref needs a value");
      expect(deploy(["--ref", "--force"]).out).toContain("--ref needs a tag or branch name");
      expect(deploy(["--ref", "a b"]).out).toContain("--ref needs a tag or branch name");
    });

    it("--dry-run prints the tag checkout instead of the fast-forward, even from another branch", () => {
      git(work, "checkout", "-q", "-B", "feature");
      try {
        const r = deploy(["--dry-run", "--ref", "v9.9.9"]);
        expect(r.status).toBe(0);
        expect(r.out).toContain("git checkout --detach <tag v9.9.9");
        expect(r.out).not.toContain("git merge --ff-only");
        expect(r.out).not.toContain("a real run would stop here");
      } finally {
        git(work, "checkout", "-q", "main");
      }
    });

    it("checks out a release tag (detached), and the default keeps following main", () => {
      const other = path.join(tmp, "other-ref");
      git(tmp, "clone", origin, other);
      const tagged = git(other, "rev-parse", "HEAD");
      git(other, "tag", "-a", "v0.0.1", "-m", "v0.0.1");
      write(path.join(other, "AFTER_TAG"), "x\n");
      git(other, "add", ".");
      git(other, "commit", "-m", "after the tag");
      git(other, "push", "origin", "main", "v0.0.1");
      try {
        const r = deploy(["--settle", "0", "--ref", "v0.0.1"], { DB_RUNNING: "1" });
        expect(r.status).toBe(0);
        expect(git(work, "rev-parse", "HEAD")).toBe(tagged);
        expect(fs.existsSync(path.join(work, "AFTER_TAG"))).toBe(false);
        expect(r.calls.some((c) => c.includes("backup.sh"))).toBe(true);
        // without --ref from a detached HEAD the branch guard applies
        expect(deploy(["--dry-run"]).out).toContain("a real run would stop here: the current branch is HEAD, not main");
      } finally {
        git(work, "checkout", "-q", "main");
      }
      expect(deploy(["--settle", "0"], { DB_RUNNING: "1" }).status).toBe(0);
      expect(fs.existsSync(path.join(work, "AFTER_TAG"))).toBe(true);
    });

    it("--verify stops on a tag without a valid signature, and rejects a branch", () => {
      const other = path.join(tmp, "other-verify");
      git(tmp, "clone", origin, other);
      git(other, "tag", "-a", "v0.0.2", "-m", "unsigned");
      git(other, "push", "origin", "v0.0.2");
      const before = git(work, "rev-parse", "HEAD");
      const r = deploy(["--settle", "0", "--ref", "v0.0.2", "--verify"], { DB_RUNNING: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("the signature of tag v0.0.2 is missing or invalid");
      expect(git(work, "rev-parse", "HEAD")).toBe(before);
      expect(r.calls.some((c) => c.includes("build"))).toBe(false);
      const branch = deploy(["--settle", "0", "--ref", "main", "--verify"], { DB_RUNNING: "1" });
      expect(branch.out).toContain("--verify needs a tag");
      git(work, "checkout", "-q", "main");
    });

    it("refuses a version from before the release directories (3b -> 3a), checked on the resolved commit; HEAD and tree unchanged", () => {
      const other = path.join(tmp, "other-capability");
      git(tmp, "clone", origin, other);
      // "3a": prepare-release.sh exists, the install script has no capability line
      write(path.join(other, "scripts/ops/install-ai-worker.sh"), STEP_STUB("install-ai-worker.sh", "INSTALL"), 0o755);
      git(other, "add", ".");
      git(other, "commit", "-m", "3a shape");
      git(other, "tag", "-a", "v0.0.3", "-m", "3a");
      git(other, "branch", "old-shape");
      write(path.join(other, "scripts/ops/install-ai-worker.sh"), `${STEP_STUB("install-ai-worker.sh", "INSTALL")}# capability: ai-worker-release-dir\n`, 0o755);
      git(other, "add", ".");
      git(other, "commit", "-m", "3b shape");
      git(other, "tag", "-a", "v0.0.4", "-m", "3b");
      git(other, "push", "origin", "v0.0.3", "v0.0.4", "old-shape");
      const before = head();
      try {
        for (const ref of ["v0.0.3", "old-shape"]) {
          const r = deploy(["--settle", "0", "--ref", ref], { DB_RUNNING: "1" });
          expect(r.status).toBe(1);
          expect(r.out).toContain("is a version from before the ai-worker ran from release directories");
          expect(r.out).toContain("docs/upgrade.md#downgrade-pre-release-dir");
          expect(head()).toBe(before);
          expect(git(work, "status", "--porcelain")).toBe("");
          expect(r.calls.some((c) => c.startsWith("docker compose"))).toBe(false);
        }
        const ok = deploy(["--settle", "0", "--ref", "v0.0.4"], { DB_RUNNING: "1" });
        expect(ok.status, ok.out).toBe(0);
        expect(head()).toBe(git(other, "rev-parse", "v0.0.4^{commit}"));
      } finally {
        git(work, "checkout", "-q", "main");
      }
    });

    it("fails before anything is built when the ref does not exist", () => {
      const r = deploy(["--settle", "0", "--ref", "v404.0.0"], { DB_RUNNING: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("v404.0.0 is neither a tag nor a branch");
      expect(r.calls.some((c) => c.includes("build"))).toBe(false);
    });
  });
});

describe("scripts/ops/deploy.sh: build context from the target commit", () => {
  it("builds from a git archive of the target commit; ignored, untracked, mode-only and outside-link files stay out", () => {
    const base = head();
    const copy = path.join(tmp, "ctx-copy");
    write(path.join(work, "config/x.local.yaml"), "ignored: true\n");
    write(path.join(work, "src/x.ts"), "export const untracked = 1;\n");
    write(path.join(tmp, "outside/secret.txt"), "outside\n");
    fs.symlinkSync(path.join(tmp, "outside"), path.join(work, "outside-link"));
    git(work, "config", "core.fileMode", "false");
    fs.chmodSync(path.join(work, "bin/tool.sh"), 0o755);
    try {
      const r = deploy(["--skip-pull", "--settle", "0", "--no-prune"], { DEPLOY_TEST_CTX_COPY: copy });
      expect(r.status, r.out).toBe(0);
      expect(r.contexts).toHaveLength(2); // build, then up: the same directory
      expect(r.contexts[0]).toMatch(new RegExp(`^${realWork}/data/build/${base}-\\d+$`));
      expect(r.contexts[1]).toBe(r.contexts[0]);
      const listing = listTree(copy);
      expect(listing).toEqual(listTree(archiveOf(base)));
      expect(listing.join("\n")).not.toMatch(/x\.local\.yaml|src\/x\.ts|outside/);
      expect(listing).toContain("bin/tool.sh 644");
      // removed when the deploy ends
      expect(buildContexts()).toEqual([]);
    } finally {
      git(work, "config", "core.fileMode", "true");
      fs.chmodSync(path.join(work, "bin/tool.sh"), 0o644);
      for (const f of ["config/x.local.yaml", "src/x.ts", "outside-link"]) fs.rmSync(path.join(work, f), { force: true });
      restore(base);
    }
  });

  it("a failed run removes its build context too", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { UP_EXIT: "1" });
      expect(r.status).toBe(1);
      expect(r.contexts.length).toBeGreaterThan(0);
      expect(buildContexts()).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("a failing git archive fails the build step: compose build never runs", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { GIT_FAIL_ARCHIVE: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 6/12 "build: build the images from the target commit" failed: could not unpack the target commit into the build context');
      expect(r.gitCalls.some((c) => c.includes(" archive "))).toBe(true);
      expect(r.calls.some((c) => c.endsWith(" build"))).toBe(false);
      expect(buildContexts()).toEqual([]);
    } finally {
      restore(base);
    }
  });
});

describe("scripts/ops/deploy.sh: the target commit is fixed", () => {
  it("the archive is the target even when HEAD moves during the build; the next check then stops the deploy", () => {
    const base = head();
    const copy = path.join(tmp, "ctx-target");
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { BUILD_HOOK: COMMIT_LATE_FILE, DEPLOY_TEST_CTX_COPY: copy });
      expect(r.status).toBe(1);
      expect(r.contexts[0]).toMatch(new RegExp(`/data/build/${base}-\\d+$`));
      expect(listTree(copy)).toEqual(listTree(archiveOf(base)));
      expect(fs.existsSync(path.join(copy, "LATE"))).toBe(false);
      expect(r.out).toContain("checkout moved during deploy");
      expect(r.calls.some((c) => c.startsWith("pnpm ops:drain") || c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
    } finally {
      restore(base);
    }
  });

  it.each([
    ["HEAD moves", MOVE_HEAD],
    ["a tracked file changes", TOUCH_TRACKED],
  ])("%s during the build: the check before the release stops it; with --no-ai-worker the one before the drain (no drain, no up, no migrate)", (_label, hook) => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { BUILD_HOOK: hook });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 7/12 "release: the ai-worker\'s release directory for the target commit" failed: checkout moved during deploy');
      expect(r.calls.some((c) => c.startsWith("prepare-release.sh") || c.startsWith("pnpm ops:drain") || c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
      restore(base);
      const noWorker = deploy(["--skip-pull", "--settle", "0", "--no-ai-worker"], { BUILD_HOOK: hook });
      expect(noWorker.status).toBe(1);
      expect(noWorker.out).toContain('step 8/12 "up: start and wait until healthy (at most 300 s)" failed: checkout moved during deploy');
      expect(noWorker.calls.some((c) => c.startsWith("pnpm ops:drain") || c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("HEAD moves during the drain: the check right before compose up stops it", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_ops_drain_HOOK: MOVE_HEAD });
      expect(r.status).toBe(1);
      expect(r.calls).toContain("pnpm ops:drain");
      expect(r.out).toContain("checkout moved during deploy");
      expect(r.calls.some((c) => c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("HEAD moves during compose up: the check before the migration stops it", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { UP_HOOK: MOVE_HEAD });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 9/12 "migrate: database migrations" failed: checkout moved during deploy');
      expect(r.calls).not.toContain("pnpm migrate:run");
    } finally {
      restore(base);
    }
  });

  it("HEAD moves right after the target is fixed: the check before the install stops it (no pnpm install)", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { GIT_TARGET_HOOK: MOVE_HEAD });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 3/12 "install: dependencies" failed: checkout moved during deploy');
      expect(r.calls.some((c) => c.startsWith("pnpm"))).toBe(false);
    } finally {
      restore(base);
    }
  });

  it.each([
    ["HEAD moves", MOVE_HEAD],
    ["a tracked file changes", TOUCH_TRACKED],
  ])("%s during the install: the check before the config step stops it (no config command)", (_label, hook) => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM___frozen_lockfile_HOOK: hook });
      expect(r.status).toBe(1);
      expect(r.calls).toContain("pnpm install --frozen-lockfile");
      expect(r.out).toContain('step 4/12 "config: configuration, .env, data directories" failed: checkout moved during deploy');
      expect(r.calls.some((c) => c.startsWith("pnpm config:"))).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("a damaged index (git status fails, prints nothing) is never read as a clean checkout: preflight stops with exit 1", () => {
    const base = head();
    try {
      fs.appendFileSync(path.join(work, "src/app.ts"), "// local change\n");
      fs.writeFileSync(path.join(work, ".git/index"), "not an index");
      const r = deploy(["--skip-pull", "--settle", "0"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 1/12 "preflight: terminal, deploy lock, tools, Docker, clean checkout, external volume" failed: cannot read the state of the checkout (git status failed');
      expect(r.calls).toEqual(["docker info"]);
      expect(r.gitCalls.some((c) => / (fetch|merge|pull|archive) /.test(` ${c} `))).toBe(false);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      repairIndex();
      restore(base);
    }
  });

  it("the index gets damaged during the build: the next check fails instead of passing on empty output (no drain, no up, no migrate)", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { BUILD_HOOK: CORRUPT_INDEX });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 7/12 "release: the ai-worker\'s release directory for the target commit" failed: cannot check the checkout (git failed, see above)');
      expect(r.calls.some((c) => c.startsWith("prepare-release.sh") || c.startsWith("pnpm ops:drain") || c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
      expect(buildContexts()).toEqual([]);
    } finally {
      repairIndex();
      restore(base);
    }
  });

  it("JOB_RADAR_DEPLOY_EXPECT_SHA: another commit stops before the install; the same commit deploys", () => {
    const base = head();
    try {
      const wrong = deploy(["--skip-pull", "--settle", "0"], { JOB_RADAR_DEPLOY_EXPECT_SHA: "0".repeat(40) });
      expect(wrong.status).toBe(1);
      expect(wrong.out).toContain('step 2/12 "pull: update the code" failed: checkout is not at the approved commit');
      expect(wrong.calls).toEqual(["docker info"]);
      const right = deploy(["--skip-pull", "--settle", "0"], { JOB_RADAR_DEPLOY_EXPECT_SHA: base });
      expect(right.status, right.out).toBe(0);
    } finally {
      restore(base);
    }
  });
});

describe("scripts/ops/deploy.sh: signals", () => {
  const deployCmd = (...args: string[]): string[] => [path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "0", ...args];

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("%s during the build: the build finishes undisturbed, nothing further starts, then cleanup once, exit %i", async (signal, code) => {
    const base = head();
    try {
      const run = startDeploy(deployCmd(), { BUILD_HOOK: BLOCK("build"), BLOCK_GRANDCHILD: "1" });
      await waitFor("the build to start", () => logHas("# build started"));
      process.kill(-run.pid, signal);
      await sleep(400);
      expect(logHas("# release")).toBe(false); // nothing is cleaned up while the step runs
      release();
      const r = await run.done;
      expect(r.status).toBe(code);
      expect(r.events.some((e) => e.startsWith("# build signal"))).toBe(false);
      expect(r.events).toContain("# build exit ctx=1 lock=1");
      expect(r.events.indexOf("# build grandchild done")).toBeLessThan(r.events.indexOf("# release mine=1"));
      // on_exit ran once, and it is the last thing that happened
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
      expect(r.events.at(-1)).toBe("# release mine=1");
      expect(r.calls.some((c) => c.startsWith("pnpm ops:drain") || c.includes(" up ") || c === "pnpm migrate:run")).toBe(false);
      expect(r.out).toContain("to abort it now: kill -TERM -");
      expect(buildContexts()).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      release();
      restore(base);
    }
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("%s during the ai-worker install: the install gets exactly one TERM and rolls back; the lock goes only after it and its children ended; exit %i", async (signal, code) => {
    const base = head();
    try {
      // a cooperative install: on TERM it "rolls back" for 1 s, then exits 1; a child in its group ends after 2 s
      const run = startDeploy(deployCmd(), {
        INSTALL_HOOK: BLOCK("install"),
        INSTALL_EXEC: "1",
        BLOCK_COOPERATIVE: "1",
        BLOCK_ROLLBACK_SLEEP: "1",
        BLOCK_GRANDCHILD: "2",
      });
      await waitFor("the install to start", () => logHas("# install started"));
      process.kill(-run.pid, signal);
      // deploy.sh forwards it as TERM, once (fails here when deploy.sh calls the install without --cooperative)
      await waitFor("the install to get TERM", () => logHas("# install signal TERM"), 5_000);
      process.kill(-run.pid, signal); // a second signal is only recorded
      expect(fs.existsSync(lockDir)).toBe(true);
      const r = await run.done;
      expect(r.status, r.out).toBe(code);
      expect(r.events.filter((e) => e.startsWith("# install signal"))).toEqual(["# install signal TERM"]);
      expect(r.events).toContain("# install rollback");
      const released = r.events.indexOf("# release mine=1");
      expect(released).toBeGreaterThan(-1);
      expect(r.events.findIndex((e) => e.startsWith("# install exit ") && e.endsWith(" lock=1"))).toBeLessThan(released);
      expect(r.events.indexOf("# install grandchild done")).toBeLessThan(released);
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
      expect(r.calls.some((c) => c.includes(" prune ") || c === "pnpm run doctor")).toBe(false);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(buildContexts()).toEqual([]);
    } finally {
      release();
      restore(base);
    }
  });

  it("SIGHUP during the config step (it writes the user config): it finishes, then exit 129, no build", async () => {
    const base = head();
    try {
      const run = startDeploy(deployCmd(), { PNPM_config_init_HOOK: BLOCK("config") });
      await waitFor("config:init to start", () => logHas("# config started"));
      process.kill(-run.pid, "SIGHUP");
      await sleep(300);
      release();
      const r = await run.done;
      expect(r.status).toBe(129);
      expect(r.events.some((e) => e.startsWith("# config signal"))).toBe(false);
      expect(r.events.indexOf("# config exit ctx=0 lock=1")).toBeLessThan(r.events.indexOf("# release mine=1"));
      expect(r.calls).not.toContain("pnpm config:migrate --write");
      expect(r.calls.some((c) => c.endsWith(" build"))).toBe(false);
      expect(r.events.at(-1)).toBe("# release mine=1");
    } finally {
      release();
      restore(base);
    }
  });

  it("a signal at the end of a command: the next command does not start", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_config_check_HOOK: "kill -TERM $DEPLOY_PID" });
      expect(r.status).toBe(143);
      expect(r.calls.at(-1)).toBe("pnpm config:check");
      expect(r.events.at(-1)).toBe("# release mine=1");
    } finally {
      restore(base);
    }
  });

  it("a signal between two steps (while waiting before the doctor): the doctor does not run", async () => {
    const base = head();
    try {
      const run = startDeploy([path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "5"]);
      await waitFor("the clean-up to finish", () => logHas("docker image prune -f"));
      await sleep(300);
      process.kill(-run.pid, "SIGTERM");
      const r = await run.done;
      expect(r.status).toBe(143);
      expect(r.calls).not.toContain("pnpm run doctor");
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
    } finally {
      restore(base);
    }
  });

  describe("tostop in the terminal is refused in preflight", () => {
    const inPty = (command: string): string => {
      const args = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/bash", "-c", command] : ["-qec", `/bin/bash -c '${command.replaceAll("'", "'\\''")}'`, "/dev/null"];
      const r = spawnSync("script", args, { cwd: work, encoding: "utf8", env: deployEnv({}), stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      if (r.error) throw r.error;
      return `${r.stdout}${r.stderr}`;
    };
    const script = (): string => path.join(work, "scripts/ops/deploy.sh");

    it.each([
      ["stdout and stderr are the terminal", ""],
      ["stdin is /dev/null (as under a calling script)", "</dev/null"],
      ["only stderr is the terminal", `</dev/null >"${path.join(os.tmpdir(), "deploy-tostop-out.log")}"`],
    ])("%s", (_label, redirect) => {
      const out = inPty(`stty tostop; bash "${script()}" --dry-run ${redirect}; echo "exit=$?"`);
      expect(out).toContain("the terminal has tostop set");
      expect(out).toContain("stty -tostop");
      expect(out).toContain("exit=1");
      expect(out).not.toContain("[2/12]");
    });

    it("without tostop the dry run goes on", () => {
      const out = inPty(`stty -tostop; bash "${script()}" --dry-run; echo "exit=$?"`);
      expect(out).toContain("[12/12] doctor");
      expect(out).toContain("exit=0");
    });
  });
});

describe("scripts/ops/deploy.sh: the deploy lock and in-flight records", () => {
  it("another run holds the lock: preflight refuses before anything (no clean-up, no fetch), and reports owner, records and how to clear it", () => {
    const base = head();
    const dead = deadPid();
    const stale = path.join(buildDir, `${"a".repeat(40)}-${dead}`);
    fs.mkdirSync(stale, { recursive: true });
    placeLock(ownerFixture, { [String(dead)]: `script=deploy-prod.sh\npid=${dead}\nstarted=1760000000\n`, junk: "???\n" });
    try {
      const r = deploy(["--settle", "0"]);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/owner: pid 999999 on wrapper-host, held for \d+ s/);
      expect(r.out).toContain(`${dead} ${dead} deploy-prod.sh 1760000000 gone`);
      expect(r.out).toContain("junk unreadable");
      expect(r.out).toContain(PS_COMMAND);
      expect(r.out).toContain(`rm -rf ${lockDir}`);
      expect(r.out).not.toContain(FIXTURE_TOKEN);
      expect(r.out.indexOf("release lock:")).toBeLessThan(r.out.indexOf("another deploy holds the lock"));
      expect(r.calls).toEqual([]);
      expect(r.gitCalls.some((c) => / (fetch|merge|pull) /.test(` ${c} `))).toBe(false);
      expect(fs.existsSync(stale)).toBe(true);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(ownerFixture);
      // a dry run takes no lock, it only reports this one
      const dry = deploy(["--dry-run"]);
      expect(dry.status).toBe(0);
      expect(dry.out).toContain(`a real run would stop here: the deploy lock ${lockDir} is held`);
    } finally {
      restore(base);
    }
  });

  it.skipIf(process.getuid?.() === 0)("the lock cannot be set up (inflight/ cannot be created): it is removed again, and nobody else is blamed", () => {
    const base = head();
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    try {
      resetLogs();
      // umask 0222: the new .lock is not writable, so creating inflight/ in it fails (like a permission problem would).
      const result = spawnSync("bash", ["-c", 'umask 0222; exec bash "$0" --skip-pull --settle 0', path.join(work, "scripts/ops/deploy.sh")], { cwd: work, encoding: "utf8", env: deployEnv({}), timeout: 60_000 });
      const r = collect(result.status, `${result.stdout}${result.stderr}`);
      expect(r.status).toBe(1);
      expect(r.out).toContain("releases: could not initialise the lock (cannot create");
      expect(r.out).toContain("failed: could not initialise the deploy lock");
      expect(r.out).not.toContain("another deploy holds the lock");
      expect(r.calls).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("the lock's parent cannot be created (data/releases is a file): could not initialise, nobody else is blamed", () => {
    const base = head();
    try {
      fs.mkdirSync(path.join(realWork, "data"), { recursive: true });
      fs.writeFileSync(path.join(realWork, "data/releases"), "a file\n");
      const r = deploy(["--skip-pull", "--settle", "0"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("failed: could not initialise the deploy lock");
      expect(r.out).not.toContain("another deploy holds the lock");
      expect(r.calls).toEqual([]);
    } finally {
      restore(base);
    }
  });

  it("a half-made lock that cannot be removed: released once, reported with its clear command, and the hint says to clear it first", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { TEST_HALF_MADE_LOCK: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("could not remove it again");
      expect(r.out).toContain("the lock was only partly created and could not be removed; lock left in place");
      expect(r.out).toContain(`rm -rf ${lockDir}`);
      expect(r.out).toContain("failed: could not initialise the deploy lock");
      expect(r.out).toContain("clear the leftover lock with the rm -rf command shown above, then retry");
      expect(r.out).not.toContain("another deploy holds the lock");
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
      expect(r.calls).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      restore(base);
    }
  });

  it("an inherited token that does not match, or no lock at all: preflight refuses, no stub runs, no lock is made", () => {
    const base = head();
    try {
      placeLock(ownerFixture);
      const other = deploy(["--skip-pull", "--settle", "0"], { JOB_RADAR_RELEASES_LOCK_TOKEN: "f".repeat(32) });
      expect(other.status).toBe(1);
      expect(other.calls).toEqual([]);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(ownerFixture);
      fs.rmSync(lockDir, { recursive: true });
      const none = deploy(["--skip-pull", "--settle", "0"], { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN });
      expect(none.status).toBe(1);
      expect(none.calls).toEqual([]);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      restore(base);
    }
  });

  it("an inherited lock: re-entered, never released; prune and doctor run with this run's record; the context is left for the next run", () => {
    const base = head();
    const helperRecord = `script=deploy-prod.sh\npid=${process.pid}\nstarted=1760000000\n`;
    placeLock(ownerFixture, { [String(process.pid)]: helperRecord });
    const LIST = 'echo "# $0 inflight=$(ls "$LOCK/inflight" | tr "\\n" ",") token=$([[ "$JOB_RADAR_RELEASES_LOCK_TOKEN" == ' + FIXTURE_TOKEN + ' ]] && echo same || echo other)" >> "$DEPLOY_TEST_LOG"';
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], {
        JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN,
        PRUNE_HOOK: LIST.replace("$0", "prune"),
        PNPM_doctor_HOOK: LIST.replace("$0", "doctor"),
      });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("deploy lock held by the calling script");
      expect(r.out).toContain("the deploy lock belongs to the calling script");
      const seen = r.events.filter((e) => e.startsWith("# prune") || e.startsWith("# doctor"));
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const line of seen) {
        expect(line).toMatch(new RegExp(`inflight=(\\d+,)*${process.pid},`));
        expect(line.match(/inflight=([\d,]+)/)?.[1].split(",").filter(Boolean)).toHaveLength(2);
        expect(line).toContain("token=same");
      }
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=0"]);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(ownerFixture);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toEqual([String(process.pid)]);
      const left = buildContexts();
      expect(left).toHaveLength(1);
      // the calling script releases the lock; the next direct run removes the context after registering
      fs.rmSync(lockDir, { recursive: true });
      const next = deploy(["--skip-pull", "--settle", "0"]);
      expect(next.status, next.out).toBe(0);
      expect(next.out).toContain(`removed data/build/${left[0]}`);
      expect(buildContexts()).toEqual([]);
    } finally {
      restore(base);
    }
  });

  it("the start-up clean-up runs after this run's record exists, and only removes contexts whose deploy is gone", () => {
    const base = head();
    const dead = deadPid();
    const stale = path.join(buildDir, `${"b".repeat(40)}-${dead}`);
    const alive = path.join(buildDir, `${"c".repeat(40)}-${process.pid}`);
    const notContext = path.join(buildDir, "something-else");
    for (const d of [stale, alive, notContext]) fs.mkdirSync(d, { recursive: true });
    try {
      const r = deploy(["--skip-pull", "--settle", "0", "--no-prune"]);
      expect(r.status, r.out).toBe(0);
      const check = r.events.find((e) => e.startsWith(`# pid_alive ${dead} `));
      expect(check).toMatch(/inflight=\d+,$/);
      expect(r.events.indexOf(check ?? "")).toBeLessThan(r.events.indexOf("docker info"));
      expect(r.out.indexOf("deploy lock taken")).toBeLessThan(r.out.indexOf(`removed data/build/${path.basename(stale)}`));
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(alive)).toBe(true);
      expect(fs.existsSync(notContext)).toBe(true);
    } finally {
      restore(base);
    }
  });

  it("another record appears during the build, which then fails: on_exit keeps the lock and the context, exit 1", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { BUILD_HOOK: ADD_OTHER_RECORD, BUILD_EXIT: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("descendant exit not confirmed; lock left in place");
      expect(r.out).toContain(PS_COMMAND);
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toEqual(["1"]);
      expect(buildContexts()).toHaveLength(1);
    } finally {
      restore(base);
    }
  });

  it("the explicit release before the prune finds another record: reported once, exit 1, lock and context kept, no prune", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_migrate_run_HOOK: ADD_OTHER_RECORD });
      expect(r.status).toBe(1);
      expect(r.events.filter((e) => e.startsWith("# release"))).toEqual(["# release mine=1"]);
      expect(r.out.split("descendant exit not confirmed").length - 1).toBe(2); // the library's line and the failed step
      expect(r.out.split("release lock:").length - 1).toBe(1);
      expect(r.out).toContain('step 11/12 "prune: release the deploy lock, clean the Docker build cache and dangling images" failed');
      expect(r.calls.some((c) => c.includes("prune") || c === "pnpm run doctor")).toBe(false);
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(buildContexts()).toHaveLength(1);
    } finally {
      restore(base);
    }
  });

  it("the calling script gets TERM and deploy.sh is then killed with -9: the kept lock's 3 wins over the signal's 143", async () => {
    const base = head();
    try {
      const run = startDeploy([fakeWrapper, realLib, realWork, path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "0"], {
        BUILD_HOOK: `echo "# deploy pid=$DEPLOY_PID" >> "$DEPLOY_TEST_LOG"; ${BLOCK("build")}`,
      });
      await waitFor("the build to start", () => logHas("# build started"));
      const deployPid = Number(/# deploy pid=(\d+)/.exec(fs.readFileSync(log, "utf8"))?.[1]);
      process.kill(run.pid, "SIGTERM");
      await sleep(300);
      process.kill(deployPid, "SIGKILL");
      release();
      const r = await run.done;
      expect(r.events).toContain("# helper deploy rc=137");
      expect(r.events).toContain("# helper release rc=3");
      expect(r.status).toBe(3);
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
    } finally {
      release();
      restore(base);
    }
  });

  // The install registers its own in-flight record (as install-ai-worker.sh does), starts a grandchild in a group of its
  // own that later reads the build context, logs its PID and blocks; the test then kills only the install with -9.
  const installKilledHook = (mark: string): string =>
    `source "$WORK/scripts/ops/lib/releases.sh"; releases_inflight_register "$WORK" install-ai-worker.sh || exit 9; ` +
    `set -m; ( sleep 3; [[ -d "$LOCK" ]] && echo done > "${mark}" ) & set +m; echo "# install pid=$$" >> "$DEPLOY_TEST_LOG"; exec env ${BLOCK("install")}`;
  const installPid = (): number => Number(/# install pid=(\d+)/.exec(fs.readFileSync(log, "utf8"))?.[1]);

  it("only the install is killed with -9: deploy.sh exits 1 (descendant exit not confirmed), the lock, its owner and the install's record stay; the next run is refused", async () => {
    const base = head();
    const mark = path.join(tmp, "install-grandchild-mark");
    fs.rmSync(mark, { force: true });
    try {
      const run = startDeploy([path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "0"], { INSTALL_HOOK: installKilledHook(mark), INSTALL_EXEC: "1" });
      await waitFor("the install to start", () => logHas("# install started"));
      const pid = installPid();
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toContain(String(pid));
      process.kill(pid, "SIGKILL");
      const r = await run.done;
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("the ai-worker switch failed (install-ai-worker.sh exited 137)");
      expect(r.out).toContain("descendant exit not confirmed");
      expect(r.calls.some((c) => c.includes(" prune ") || c === "pnpm run doctor")).toBe(false);
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toEqual([String(pid)]);
      expect(buildContexts()).toHaveLength(1);

      const next = deploy(["--settle", "0"]);
      expect(next.status).toBe(1);
      expect(next.out).toContain("another deploy holds the lock");
      expect(next.out).toContain(`${pid} install-ai-worker.sh`);
      expect(next.gitCalls.some((c) => / (fetch|merge|pull) /.test(` ${c} `))).toBe(false);

      // the grandchild the killed install left behind still found the lock in place
      await waitFor("the grandchild to finish", () => fs.existsSync(mark), 15_000);
    } finally {
      release();
      restore(base);
    }
  });

  it("the same through a calling script that holds the lock: deploy.sh exits 1, the caller's release keeps the lock (3), the context stays", async () => {
    const base = head();
    const mark = path.join(tmp, "install-grandchild-mark-helper");
    fs.rmSync(mark, { force: true });
    try {
      const run = startDeploy([fakeWrapper, realLib, realWork, path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "0"], {
        INSTALL_HOOK: installKilledHook(mark),
        INSTALL_EXEC: "1",
      });
      await waitFor("the install to start", () => logHas("# install started"));
      const pid = installPid();
      process.kill(pid, "SIGKILL");
      const r = await run.done;
      expect(r.events).toContain("# helper deploy rc=1");
      expect(r.events).toContain("# helper release rc=3");
      expect(r.status).toBe(3);
      expect(r.out).toContain("descendant exit not confirmed");
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toContain(String(pid));
      expect(buildContexts()).toHaveLength(1);
      await waitFor("the grandchild to finish", () => fs.existsSync(mark), 15_000);
    } finally {
      release();
      restore(base);
    }
  });

  it("the explicit release finds another run's token in the owner file: it says so, offers no clear command, exit 1, no prune", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_migrate_run_HOOK: `printf '${ownerFixture.replaceAll("\n", "\\n")}' > "$LOCK/owner"` });
      expect(r.status).toBe(1);
      expect(r.out).toContain('step 11/12 "prune: release the deploy lock, clean the Docker build cache and dangling images" failed: the deploy lock now belongs to another run');
      expect(r.out).not.toContain("descendant exit not confirmed");
      expect(r.out).not.toContain("rm -rf");
      expect(r.calls.some((c) => c.includes("prune") || c === "pnpm run doctor")).toBe(false);
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(ownerFixture);
      expect(buildContexts()).toHaveLength(1);
    } finally {
      restore(base);
    }
  });

  it("the explicit release finds the lock gone: it says so (no clear command), exit 1", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_migrate_run_HOOK: 'rm -rf "$LOCK"' });
      expect(r.status).toBe(1);
      expect(r.out).toContain("failed: the deploy lock disappeared while this deploy held it");
      expect(r.out).not.toContain("rm -rf");
    } finally {
      restore(base);
    }
  });

  it("the explicit release finds an unexpected entry in the lock: it names that cause, not the records", () => {
    const base = head();
    try {
      const r = deploy(["--skip-pull", "--settle", "0"], { PNPM_migrate_run_HOOK: 'touch "$LOCK/stray"' });
      expect(r.status).toBe(1);
      expect(r.out).toContain("failed: the deploy lock holds unexpected entries; lock left in place");
      expect(r.out).not.toContain("descendant exit not confirmed");
      expect(r.out).toContain(`rm -rf ${lockDir}`);
    } finally {
      restore(base);
    }
  });

  it("a calling script holds the lock and deploy.sh is killed with -9 mid-build: the lock stays, the next run is refused before fetching, and the build's grandchild still reads its context", async () => {
    const base = head();
    const mark = path.join(tmp, "grandchild-mark");
    fs.rmSync(mark, { force: true });
    fs.rmSync(`${mark}.read`, { force: true });
    const grandchild = `set -m; ( sleep 3; cat "$JOB_RADAR_BUILD_CONTEXT/package.json" > "${mark}.read" && echo done > "${mark}" ) & set +m; echo "# deploy pid=$DEPLOY_PID" >> "$DEPLOY_TEST_LOG"; ${BLOCK("build")}`;
    try {
      const run = startDeploy([fakeWrapper, realLib, realWork, path.join(work, "scripts/ops/deploy.sh"), "--skip-pull", "--settle", "0"], { BUILD_HOOK: grandchild });
      await waitFor("the build to start", () => logHas("# build started"));
      const deployPid = Number(/# deploy pid=(\d+)/.exec(fs.readFileSync(log, "utf8"))?.[1]);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toContain(String(deployPid));
      process.kill(deployPid, "SIGKILL");
      release();
      const r = await run.done;
      expect(r.status).toBe(3);
      expect(r.events).toContain("# helper deploy rc=137");
      expect(r.events).toContain("# helper release rc=3");
      expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
      expect(fs.readdirSync(path.join(lockDir, "inflight"))).toEqual([String(deployPid)]);
      const context = buildContexts();
      expect(context).toHaveLength(1);

      const next = deploy(["--settle", "0"]);
      expect(next.status).toBe(1);
      expect(next.out).toContain("another deploy holds the lock");
      expect(next.out).toContain(`${deployPid} ${deployPid} deploy.sh`);
      expect(next.gitCalls.some((c) => / (fetch|merge|pull) /.test(` ${c} `))).toBe(false);
      expect(buildContexts()).toEqual(context);

      await waitFor("the grandchild to finish", () => fs.existsSync(mark), 15_000);
      expect(fs.readFileSync(`${mark}.read`, "utf8")).toBe('{"name":"job-radar"}\n');
    } finally {
      release();
      restore(base);
    }
  });
});
