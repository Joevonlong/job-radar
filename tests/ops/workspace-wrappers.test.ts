// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The workspace's thin wrappers (scripts/<name>.sh -> job-radar/scripts/ops/<name>.sh) must behave exactly like the product
 * scripts: same arguments, same output, same exit codes. They only exist while the product sits inside the workspace
 * repository, so the whole suite is skipped in a standalone product checkout.
 * The product can be at <workspace>/job-radar or <workspace>/.claude/worktrees/<id>.
 * JOB_RADAR_TEST_WORKSPACE_DIR overrides discovery (relative paths resolve from cwd); point it at an empty directory
 * to exercise the standalone skip without falling back to the surrounding workspace.
 */
const productRoot = path.resolve(import.meta.dirname, "../..");
const productParent = path.dirname(productRoot);
const inWorkerWorktree = path.basename(productParent) === "worktrees" && path.basename(path.dirname(productParent)) === ".claude";
const workspace = path.resolve(
  process.env.JOB_RADAR_TEST_WORKSPACE_DIR ?? (inWorkerWorktree ? path.resolve(productParent, "../..") : productParent),
);
const productOps = path.join(productRoot, "scripts/ops");
const productLib = path.join(productOps, "lib");
const wrapperDir = path.join(workspace, "scripts");
const names = ["deploy", "backup", "restore", "install-ai-worker", "uninstall-ai-worker"];
const present = names.every((n) => fs.existsSync(path.join(wrapperDir, `${n}.sh`)));

if (!present) {
  console.warn(`Skipping workspace wrappers: required scripts/<name>.sh files were not found in ${workspace}. `
    + "Standalone product checkouts do not include these wrappers; set JOB_RADAR_TEST_WORKSPACE_DIR to override discovery.");
}

let tmp = "";
let ws = "";
let stubs = "";
let log = "";

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, DEPLOY_TEST_LOG: log, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

describe.skipIf(!present)("workspace wrappers", () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-test-"));
    ws = path.join(tmp, "ws");
    stubs = path.join(tmp, "bin");
    log = path.join(tmp, "calls.log");
    // a workspace-shaped fake: wrappers at the root, the product (with the real ops scripts) in job-radar/
    for (const n of names) {
      write(path.join(ws, "scripts", `${n}.sh`), fs.readFileSync(path.join(wrapperDir, `${n}.sh`), "utf8"), 0o755);
      write(path.join(ws, "job-radar/scripts/ops", `${n}.sh`), fs.readFileSync(path.join(productOps, `${n}.sh`), "utf8"), 0o755);
    }
    // helpers the ops scripts source from scripts/ops/lib/ (timezone, ai-worker, ...)
    for (const f of fs.readdirSync(productLib)) {
      write(path.join(ws, "job-radar/scripts/ops/lib", f), fs.readFileSync(path.join(productLib, f), "utf8"), 0o755);
    }
    write(path.join(ws, "job-radar/package.json"), '{"name":"job-radar"}\n');
    write(path.join(ws, "job-radar/config/schedule.yaml"), "timezone: Europe/Berlin\ndoctor:\n  compose_project: radar-test\n");
    write(path.join(stubs, "docker"), '#!/usr/bin/env bash\necho "docker $*" >> "$DEPLOY_TEST_LOG"\nexit 0\n', 0o755);
    write(path.join(stubs, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$DEPLOY_TEST_LOG"\nexit 0\n', 0o755);
    write(log, "");
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: ws, encoding: "utf8" });
    git("init", "-q", "--initial-branch=main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("every wrapper passes bash -n and execs the product script", () => {
    for (const n of names) {
      const wrapper = path.join(wrapperDir, `${n}.sh`);
      expect(spawnSync("bash", ["-n", wrapper]).status, n).toBe(0);
      const text = fs.readFileSync(wrapper, "utf8");
      expect(text, n).toContain(`job-radar/scripts/ops/${n}.sh`);
      expect(text, n).toMatch(/^\s*exec\s.*"\$@"/m);
      expect(fs.statSync(wrapper).mode & 0o111, `${n} is executable`).not.toBe(0);
    }
  });

  it.each(names)("%s.sh --help prints the product script's usage with the same exit code", (n) => {
    const viaWrapper = run(path.join(ws, "scripts", `${n}.sh`), ["--help"]);
    const direct = run(path.join(ws, "job-radar/scripts/ops", `${n}.sh`), ["--help"]);
    expect(viaWrapper).toEqual(direct);
    expect(viaWrapper.status).toBe(0);
    expect(viaWrapper.out.length).toBeGreaterThan(50);
  });

  it("deploy.sh: unknown arguments fail with exit code 1 like the product script", () => {
    const r = run(path.join(ws, "scripts/deploy.sh"), ["--nope"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("unknown argument: --nope");
  });

  it("deploy.sh --dry-run finds the product root (job-radar/) and prints every step of the plan", () => {
    const r = run(path.join(ws, "scripts/deploy.sh"), ["--dry-run", "--skip-pull"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`checkout: ${fs.realpathSync(path.join(ws, "job-radar"))}  project: radar-test`);
    const steps = [...r.out.matchAll(/^\[(\d+)\/(\d+)\]/gm)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const total = steps[0]?.[1] ?? 0;
    expect(total).toBeGreaterThanOrEqual(1);
    expect(steps.map(([, t]) => t)).toEqual(steps.map(() => total));
    expect(steps.map(([n]) => n)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(r.out).toContain("dry-run finished");
  });

  it("deploy.sh keeps this workspace's external-volume guard on by default, and lets the environment turn it off", () => {
    const volume = path.join(fs.realpathSync(tmp), "Vol");
    fs.mkdirSync(`${volume} 1`, { recursive: true });
    const guarded = run(path.join(ws, "scripts/deploy.sh"), ["--dry-run", "--skip-pull"], { JOB_RADAR_DEPLOY_VOLUME: volume });
    expect(guarded.out).toContain(`${volume} 1 exists: the external volume is mounted twice`);
    const off = run(path.join(ws, "scripts/deploy.sh"), ["--dry-run", "--skip-pull"], { JOB_RADAR_DEPLOY_VOLUME: "" });
    expect(off.out).not.toContain("the external volume is mounted twice");
    expect(fs.readFileSync(path.join(wrapperDir, "deploy.sh"), "utf8")).toContain("JOB_RADAR_DEPLOY_VOLUME");
  });

  it("backup.sh rejects a bad --label with exit code 2, restore.sh without a file with exit code 2", () => {
    expect(run(path.join(ws, "scripts/backup.sh"), ["--label", "bad label"]).status).toBe(2);
    expect(run(path.join(ws, "scripts/restore.sh"), []).status).toBe(2);
  });
});
