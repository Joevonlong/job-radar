// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/deploy.sh, run for real against a throw-away git repository and stub `docker` / `pnpm`
 * commands that only log what they were asked to do. Nothing here touches the real stack.
 */
const realScript = path.resolve(import.meta.dirname, "../../scripts/ops/deploy.sh");

let tmp = "";
let work = "";
let origin = "";
let stubs = "";
let log = "";

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

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  origin = path.join(tmp, "origin.git");
  work = path.join(tmp, "work");
  stubs = path.join(tmp, "bin");
  log = path.join(tmp, "calls.log");

  git(tmp, "init", "--bare", "--initial-branch=main", origin);
  git(tmp, "clone", origin, work);
  write(path.join(work, "scripts/ops/deploy.sh"), fs.readFileSync(realScript, "utf8"), 0o755);
  write(path.join(work, "scripts/ops/backup.sh"), LOGGING_STUB("backup.sh"), 0o755);
  write(path.join(work, "scripts/ops/install-ai-worker.sh"), LOGGING_STUB("install-ai-worker.sh"), 0o755);
  write(path.join(work, "package.json"), '{"name":"job-radar"}\n');
  write(path.join(work, "config/schedule.yaml"), "timezone: Europe/Berlin\ndoctor:\n  compose_project: radar-test\n  web_url: http://127.0.0.1:3000\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "main");

  // stub docker: `info` ok, `compose ... ps --status running --services` lists db when DB_RUNNING=1, everything else is logged.
  write(
    path.join(stubs, "docker"),
    `#!/usr/bin/env bash
echo "docker $*" >> "$DEPLOY_TEST_LOG"
[[ "$1" == "info" ]] && exit \${DOCKER_INFO_EXIT:-0}
if [[ "$*" == *"ps --status running --services"* ]]; then [[ "\${DB_RUNNING:-0}" == "1" ]] && echo db; exit 0; fi
if [[ "$*" == *" up "* ]]; then exit \${UP_EXIT:-0}; fi
if [[ "$*" == *" prune "* ]]; then
  if [[ -n "\${PRUNE_EXIT:-}" ]]; then echo "unknown flag: --max-used-space" >&2; exit "$PRUNE_EXIT"; fi
  printf 'deleted sha256:aaa\\nTotal:\\t1.2GB\\n'; exit 0
fi
exit 0
`,
    0o755,
  );
  // stub pnpm: logs and exits with PNPM_<script>_EXIT (e.g. PNPM_doctor_EXIT=2)
  write(
    path.join(stubs, "pnpm"),
    `#!/usr/bin/env bash
echo "pnpm $*" >> "$DEPLOY_TEST_LOG"
name="\${*: -1}"; name="\${name//:/_}"; name="\${name//-/_}"
var="PNPM_\${name}_EXIT"
exit \${!var:-0}
`,
    0o755,
  );
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function deploy(args: string[], env: Record<string, string> = {}): { status: number | null; out: string; calls: string[] } {
  fs.writeFileSync(log, "");
  const result = spawnSync("bash", [path.join(work, "scripts/ops/deploy.sh"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, DEPLOY_TEST_LOG: log, ...env },
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(log, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) };
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

  it("--dry-run prints the eleven steps in order and runs no docker, pnpm or script", () => {
    const r = deploy(["--dry-run"], { DB_RUNNING: "1" });
    expect(r.status).toBe(0);
    const steps = [...r.out.matchAll(/^\[(\d+)\/11\] (\S+?):/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual(["1 preflight", "2 pull", "3 install", "4 config", "5 backup", "6 build", "7 up", "8 prune", "9 migrate", "10 ai-worker", "11 doctor"]);
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
      "$ docker compose -p radar-test build",
      "$ pnpm ops:drain",
      "$ docker compose -p radar-test up -d --wait --wait-timeout 300",
      "$ docker builder prune -f --max-used-space 5gb",
      "$ docker image prune -f",
      "$ pnpm migrate:run",
      "$ scripts/ops/install-ai-worker.sh",
      "$ pnpm run doctor",
    ]) {
      expect(r.out, line).toContain(line);
    }
    expect(r.out).toContain("dry-run finished: nothing was changed");
    // only read-only probes: docker info and the `ps` that asks whether the db runs
    expect(r.calls.every((c) => c === "docker info" || c.includes("ps --status running --services"))).toBe(true);
  });

  it("--dry-run shows what would stop a real run, and still prints every step", () => {
    git(work, "checkout", "-q", "-B", "feature");
    try {
      const r = deploy(["--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.out).toContain("a real run would stop here: the current branch is feature, not main");
      expect(r.out).toContain("[11/11] doctor");
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
    expect(wrongBranch.out).toContain('step 2/11 "pull: update the code" failed: the current branch is feature, not main');
    expect(wrongBranch.calls).toEqual(["docker info"]);

    write(path.join(work, "scripts/ops/backup.sh"), `${LOGGING_STUB("backup.sh")}# changed\n`, 0o755);
    try {
      const dirty = deploy([]);
      expect(dirty.status).toBe(1);
      expect(dirty.out).toContain("there are uncommitted changes");
    } finally {
      git(work, "checkout", "--", "scripts/ops/backup.sh");
    }
  });

  it("a full run: fast-forwards, then installs, checks, backs up, builds, starts, migrates, installs the worker and runs the doctor, in that order", () => {
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
      "pnpm ops:drain",
      "docker compose -p radar-test up -d --wait --wait-timeout 300",
      "docker builder prune -f --max-used-space 5gb",
      "docker image prune -f",
      "pnpm migrate:run",
      "install-ai-worker.sh",
      "pnpm run doctor",
    ]);
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
    const schedule = path.join(work, "config/schedule.yaml");
    const original = fs.readFileSync(schedule, "utf8");
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
      fs.writeFileSync(schedule, original);
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
    expect(r.out).toContain('step 7/11 "up: start and wait until healthy (at most 300 s)" failed: not all services became healthy within 300 s');
    expect(r.out).toContain("What to do: docker compose -p radar-test logs --tail 100");
    expect(r.calls.some((c) => c.startsWith("pnpm migrate:run") || c.startsWith("install-ai-worker.sh") || c === "pnpm run doctor")).toBe(false);
  });

  it("stops when config:check fails, before the build", () => {
    const r = deploy(["--settle", "0"], { PNPM_config_check_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("step 4/11");
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
      expect(real.out).toContain("step 1/11");
    } finally {
      fs.rmSync(`${volume} 1`, { recursive: true, force: true });
    }
  });

  it("stops when Docker is not running", () => {
    const r = deploy(["--settle", "0"], { DOCKER_INFO_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("step 1/11");
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

    it("fails before anything is built when the ref does not exist", () => {
      const r = deploy(["--settle", "0", "--ref", "v404.0.0"], { DB_RUNNING: "1" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("v404.0.0 is neither a tag nor a branch");
      expect(r.calls.some((c) => c.includes("build"))).toBe(false);
    });
  });
});
