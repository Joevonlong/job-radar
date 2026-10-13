// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/lib/proc.sh: process groups, signals and exit codes of the deploy scripts. The shell cases live in
 * tests/ops/proc-lib/cases.sh so CI can also run them in the bash:3.2 and bash:5.2 images; here they run with /bin/bash
 * (3.2 on macOS, 5 on Ubuntu). The pseudo-terminal cases (they need `script`) and the real-pnpm case run only here.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const procSh = path.join(repo, "scripts/ops/lib/proc.sh");
const cases = path.join(repo, "tests/ops/proc-lib/cases.sh");

let tmp = "";
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proc-lib-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Run a bash command in a pseudo-terminal: `script` ships with macOS and with util-linux on Ubuntu (a missing one fails).
function inPty(command: string): { status: number | null; out: string } {
  const args = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/bash", "-c", command] : ["-qec", `/bin/bash -c '${command.replaceAll("'", "'\\''")}'`, "/dev/null"];
  const r = spawnSync("script", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("scripts/ops/lib/proc.sh", () => {
  it("passes bash -n", () => {
    expect(spawnSync("/bin/bash", ["-n", procSh]).status).toBe(0);
  });

  it("passes every shell case in tests/ops/proc-lib/cases.sh with /bin/bash", () => {
    const r = spawnSync("/bin/bash", [cases], { encoding: "utf8", timeout: 240_000 });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, out).toContain("all proc.sh cases passed");
    expect(out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  }, 300_000);

  it("no script passes extra environment through `env` after proc_run (the value would show in env's argv)", () => {
    const r = spawnSync("grep", ["-rnE", "proc_run( --cooperative)?[[:space:]]+env([[:space:]]|$)", "scripts/ops"], { cwd: repo, encoding: "utf8" });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
  });

  it("the only `trap` lines in the deploy scripts are in proc_traps", () => {
    for (const file of ["scripts/ops/deploy.sh", "scripts/ops/lib/releases.sh"]) {
      expect(fs.readFileSync(path.join(repo, file), "utf8"), file).not.toMatch(/^\s*trap\b/m);
    }
  });

  describe("proc_tostop_set in a pseudo-terminal", () => {
    const call = (setting: string, redirect: string): string => `stty ${setting}; source "${procSh}"; if proc_tostop_set ${redirect}; then echo TOSTOP=yes >&3; else echo TOSTOP=no >&3; fi`;
    const result = (setting: string, redirect: string): string => {
      const file = path.join(tmp, `tostop-${Math.random().toString(36).slice(2)}`);
      const r = inPty(`exec 3>"${file}"; ${call(setting, redirect)}`);
      expect(r.status, r.out).toBe(0);
      return fs.readFileSync(file, "utf8").trim();
    };

    it("stdout is the terminal with tostop set: 0", () => {
      expect(result("tostop", "")).toBe("TOSTOP=yes");
    });

    it("only stderr is the terminal (stdout goes to a file): 0", () => {
      expect(result("tostop", `>"${path.join(tmp, "stdout.txt")}"`)).toBe("TOSTOP=yes");
    });

    it("neither stdout nor stderr is a terminal: 1 (not checked)", () => {
      expect(result("tostop", `>"${path.join(tmp, "both.txt")}" 2>&1`)).toBe("TOSTOP=no");
    });

    it("-tostop is not mistaken for tostop", () => {
      expect(result("-tostop", "")).toBe("TOSTOP=no");
    });
  });

  it("what pnpm starts (node) stays in the process group proc_run created for pnpm", () => {
    const pidFile = path.join(tmp, "pnpm-pid");
    const pgidFile = path.join(tmp, "node-pgid");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `source "${procSh}"; proc_run bash -c 'echo $$ > "$1"; exec pnpm --silent --dir "$2" run pgid' _ "${pidFile}" "${path.join(repo, "tests/fixtures/ops/pnpm-pgid")}"`],
      { encoding: "utf8", env: { ...process.env, PGID_OUT: pgidFile }, timeout: 60_000 },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const pnpmPid = fs.readFileSync(pidFile, "utf8").trim();
    expect(pnpmPid).toMatch(/^\d+$/);
    expect(fs.readFileSync(pgidFile, "utf8").trim()).toBe(pnpmPid);
  });
});
