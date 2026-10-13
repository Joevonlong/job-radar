// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ai_worker_wait_stopped / ai_worker_wait_ready of scripts/ops/lib/ai-worker.sh with stub `launchctl` and `systemctl`
 * first on PATH (state read from files in a temp directory) and a made-up label: no real service manager is asked.
 * The database side of wait_ready is covered by tests/integration/worker-heartbeat.test.ts.
 */
const lib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/ai-worker.sh");
const LABEL = "test.invalid.ai-worker-stub";

let tmp = "";
let bin = "";
let state = "";

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-wait-"));
  bin = path.join(tmp, "bin");
  state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  // launchctl print <domain>/<label>: succeeds while state/loaded (any label) or state/loaded-<label> exists
  write(
    path.join(bin, "launchctl"),
    `#!/bin/bash\necho "launchctl $*" >> "${state}/calls"\n[[ -n "\${STUB_LAUNCHCTL_SLEEP:-}" ]] && sleep "$STUB_LAUNCHCTL_SLEEP"\n[[ "$1" == print && ( -e "${state}/loaded" || -e "${state}/loaded-\${2##*/}" ) ]] && { echo "pid = 4242"; exit 0; }\nexit 113\n`,
    0o755,
  );
  // node: stands in for the worker-heartbeat.ts --evidence probe (sleeps STUB_NODE_SLEEP, exits STUB_NODE_EXIT)
  write(
    path.join(bin, "node"),
    `#!/bin/bash\necho "node $*" >> "${state}/calls"\necho $$ > "${state}/node-pid"\n[[ -n "\${STUB_NODE_SLEEP:-}" ]] && sleep "$STUB_NODE_SLEEP"\nexit "\${STUB_NODE_EXIT:-0}"\n`,
    0o755,
  );
  // systemctl --user show / list-jobs: from state/show (a counter appended each call for NRestarts) and state/jobs
  write(
    path.join(bin, "systemctl"),
    `#!/bin/bash
echo "systemctl $*" >> "${state}/calls"
case "$2" in
  show) cat "${state}/show"; if [[ -e "${state}/restarting" ]]; then echo "NRestarts=$(wc -l < "${state}/calls" | tr -d ' ')"; else echo "NRestarts=3"; fi ;;
  list-jobs) cat "${state}/jobs" 2>/dev/null ;;
esac
exit 0
`,
    0o755,
  );
});
afterEach(() => {
  if (tmp && path.basename(tmp).startsWith("ai-worker-wait-")) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

const deadPid = (): string => spawnSync("/bin/bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();

function run(snippet: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string; ms: number } {
  const started = Date.now();
  const vars = Object.entries({ PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, ...env }).map(([k, v]) => `${k}=${v}`);
  const r = spawnSync("/usr/bin/env", ["-i", ...vars, "/bin/bash", "-c", `source "${lib}"; ${snippet}`], { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}
const calls = (): string[] => (fs.existsSync(path.join(state, "calls")) ? fs.readFileSync(path.join(state, "calls"), "utf8").split("\n").filter(Boolean) : []);

describe("ai_worker_wait_stopped (launchd)", () => {
  it("0 once the agent is gone and the PID is dead", () => {
    const r = run(`ai_worker_wait_stopped ${LABEL} ${deadPid()} 5; echo "rc=$?"`, { JOB_RADAR_SERVICE_MANAGER: "launchd" });
    expect(r.stdout.trim()).toBe("rc=0");
    expect(calls().every((c) => c.startsWith(`launchctl print gui/`) && c.endsWith(`/${LABEL}`))).toBe(true);
  });

  it("1 on timeout while the agent is still loaded", () => {
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_wait_stopped ${LABEL} ${deadPid()} 1; echo "rc=$?"`, { JOB_RADAR_SERVICE_MANAGER: "launchd" });
    expect(r.stdout.trim()).toBe("rc=1");
  });

  it("1 on timeout while the PID is still alive (this test's own shell), even with the agent gone", () => {
    const r = run(`ai_worker_wait_stopped ${LABEL} $$ 1; echo "rc=$?"`, { JOB_RADAR_SERVICE_MANAGER: "launchd" });
    expect(r.stdout.trim()).toBe("rc=1");
  });

  it("refuses a timeout that is not whole seconds", () => {
    const r = run(`ai_worker_wait_stopped ${LABEL} 1 1.5; echo "rc=$?"`, { JOB_RADAR_SERVICE_MANAGER: "launchd" });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.stderr).toContain("whole seconds");
  });

  it("ai_worker_service_pid reads the pid launchctl prints; ai_worker_pid_alive never treats 0 as alive", () => {
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_service_pid launchd ${LABEL}; ai_worker_pid_alive 0 && echo zero-alive; ai_worker_pid_alive $$ && echo self-alive`, {});
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["4242", "self-alive"]);
  });
});

describe("ai_worker_wait_stopped (systemd)", () => {
  const env = { JOB_RADAR_SERVICE_MANAGER: "systemd" };

  it("0 when inactive, MainPID=0, no job, NRestarts unchanged between two readings and the PID dead", () => {
    write(path.join(state, "show"), "ActiveState=inactive\nSubState=dead\nMainPID=0\n");
    const r = run(`ai_worker_wait_stopped job-radar-ai-worker.service ${deadPid()} 10; echo "rc=$?"`, env);
    expect(r.stdout.trim()).toBe("rc=0");
    // a first reading only sets the NRestarts baseline
    expect(calls().filter((c) => c.includes(" show ")).length).toBeGreaterThanOrEqual(2);
  });

  it("failed counts as stopped too", () => {
    write(path.join(state, "show"), "ActiveState=failed\nSubState=failed\nMainPID=0\n");
    expect(run(`ai_worker_wait_stopped job-radar-ai-worker.service ${deadPid()} 10; echo "rc=$?"`, env).stdout.trim()).toBe("rc=0");
  });

  it.each([
    ["still active", "ActiveState=active\nSubState=running\nMainPID=4242\n", null, false],
    ["a pending job", "ActiveState=inactive\nSubState=dead\nMainPID=0\n", "12 job-radar-ai-worker.service start waiting\n", false],
    ["a MainPID left", "ActiveState=inactive\nSubState=dead\nMainPID=77\n", null, false],
    ["NRestarts still moving", "ActiveState=inactive\nSubState=dead\nMainPID=0\n", null, true],
  ])("1 on timeout with %s", (_label, show, jobs, restarting) => {
    write(path.join(state, "show"), show);
    if (jobs) write(path.join(state, "jobs"), jobs);
    if (restarting) write(path.join(state, "restarting"), "");
    expect(run(`ai_worker_wait_stopped job-radar-ai-worker.service ${deadPid()} 1; echo "rc=$?"`, env).stdout.trim()).toBe("rc=1");
  });
});

describe("ai_worker_wait_ready: arguments", () => {
  it("returns 1 at once when DATABASE_URL is empty (never read from .env); nothing is asked", () => {
    write(path.join(tmp, "main/.env"), "DATABASE_URL=postgres://x:y@127.0.0.1:1/z\n");
    const r = run(`ai_worker_wait_ready "${path.join(tmp, "main")}" "" 2026-01-01T00:00:00Z 5; echo "rc=$?"`, { JOB_RADAR_SERVICE_MANAGER: "launchd" });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.stderr).toContain("needs DATABASE_URL");
    expect(calls()).toEqual([]);
  });

  it("returns 1 when the identity is ambiguous, before asking the service manager", () => {
    write(path.join(tmp, "Library/LaunchAgents/io.jobradar.ai-worker.plist"), "<plist/>\n");
    write(path.join(tmp, "Library/LaunchAgents/de.jobradar.ai-worker.plist"), "<plist/>\n");
    const r = run(`ai_worker_wait_ready "${path.join(tmp, "main")}" "" 2026-01-01T00:00:00Z 5; echo "rc=$?"`, {
      JOB_RADAR_SERVICE_MANAGER: "launchd",
      DATABASE_URL: "postgres://unused@127.0.0.1:1/none",
    });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(calls()).toEqual([]);
  });

  it("returns 1 when no definition is installed: there is nothing to wait for", () => {
    const r = run(`ai_worker_wait_ready "${path.join(tmp, "main")}" "" 2026-01-01T00:00:00Z 5; echo "rc=$?"`, {
      JOB_RADAR_SERVICE_MANAGER: "launchd",
      DATABASE_URL: "postgres://unused@127.0.0.1:1/none",
    });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.stderr).toContain("no ai-worker definition is installed");
    expect(calls()).toEqual([]);
  });

  it("times out (1) while the service manager reports only the old PID", () => {
    write(path.join(tmp, "Library/LaunchAgents/io.jobradar.ai-worker.plist"), "<plist/>\n");
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_wait_ready "${path.join(tmp, "main")}" 4242 2026-01-01T00:00:00Z 1; echo "rc=$?"`, {
      JOB_RADAR_SERVICE_MANAGER: "launchd",
      DATABASE_URL: "postgres://unused@127.0.0.1:1/none",
    });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(calls().length).toBeGreaterThanOrEqual(1);
  });
});

describe("ai_worker_wait_ready: the service polled and the time bound", () => {
  const main = (): string => path.join(tmp, "main");
  const env = { JOB_RADAR_SERVICE_MANAGER: "launchd", DATABASE_URL: "postgres://unused@127.0.0.1:1/none" };
  const plist = (label: string): void => write(path.join(tmp, `Library/LaunchAgents/${label}.plist`), "<plist/>\n");

  it("prints the new PID once the evidence probe succeeds (worker-heartbeat.ts --evidence for that PID and this host)", () => {
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 10; echo "rc=$?"`, env);
    expect(r.stdout.trim().split("\n")).toEqual(["4242", "rc=0"]);
    const probe = calls().find((c) => c.startsWith("node "));
    expect(probe).toMatch(/scripts\/ops\/worker-heartbeat\.ts --evidence --pid 4242 --host \S+ --since 2026-01-01T00:00:00Z$/);
  });

  it("after a failed migration to a custom label, the rollback's definition under the default label is the one polled", () => {
    // configured L = com.example.custom, but the definition in force (put back by the rollback) is the default label's
    write(path.join(main(), "data/config/schedule.yaml"), "doctor:\n  ai_worker_launchd_label: com.example.custom\n");
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded-io.jobradar.ai-worker"), "");
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 10; echo "rc=$?"`, env);
    expect(r.stdout.trim().split("\n")).toEqual(["4242", "rc=0"]);
    const asked = calls().filter((c) => c.startsWith("launchctl print"));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked.every((c) => c.endsWith("/io.jobradar.ai-worker"))).toBe(true);
  });

  it("the same after a rollback to the legacy label", () => {
    write(path.join(main(), "data/config/schedule.yaml"), "doctor:\n  ai_worker_launchd_label: com.example.custom\n");
    plist("de.jobradar.ai-worker");
    write(path.join(state, "loaded-de.jobradar.ai-worker"), "");
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 10; echo "rc=$?"`, env);
    expect(r.stdout.trim().split("\n")).toEqual(["4242", "rc=0"]);
    expect(calls().filter((c) => c.startsWith("launchctl print")).every((c) => c.endsWith("/de.jobradar.ai-worker"))).toBe(true);
  });

  it("a probe slower than the time left is killed, and its late success does not count (1 within the bound)", () => {
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 2; echo "rc=$?"`, { ...env, STUB_NODE_SLEEP: "8" });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.ms).toBeLessThan(6000);
    const probePid = Number(fs.readFileSync(path.join(state, "node-pid"), "utf8").trim());
    expect(spawnSync("kill", ["-0", String(probePid)]).status).not.toBe(0);
  });

  it("a probe that keeps answering 2 (not yet) or 1 (cannot tell) times out with 1", () => {
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded"), "");
    for (const code of ["2", "1"]) {
      const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 2; echo "rc=$?"`, { ...env, STUB_NODE_EXIT: code });
      expect(r.stdout.trim()).toBe("rc=1");
    }
  });

  it("slow service-manager calls are bounded by the time left too (1 within the bound, no call left running)", () => {
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded"), "");
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 2; echo "rc=$?"`, { ...env, STUB_LAUNCHCTL_SLEEP: "8" });
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.ms).toBeLessThan(6500); // the stub hangs 8 s; the bound is 2 s (+1 for whole seconds, +1 for TERM)
    expect(calls().some((c) => c.startsWith("node "))).toBe(false);
  });

  it("a slow confirmation of the PID after the evidence is bounded as well", () => {
    plist("io.jobradar.ai-worker");
    write(path.join(state, "loaded"), "");
    // the first launchctl call answers at once; every later one (the confirmation) hangs
    write(
      path.join(bin, "launchctl"),
      `#!/bin/bash\necho "launchctl $*" >> "${state}/calls"\nif [[ -e "${state}/answered" ]]; then sleep 8; fi\ntouch "${state}/answered"\necho "pid = 4242"\n`,
      0o755,
    );
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 2; echo "rc=$?"`, env);
    expect(r.stdout.trim()).toBe("rc=1");
    expect(r.ms).toBeLessThan(6500); // the stub hangs 8 s; the bound is 2 s (+1 for whole seconds, +1 for TERM)
    expect(calls().some((c) => c.startsWith("node "))).toBe(true);
  });

  it.each([
    ["prints the PID and then fails", 'echo "pid = 4242"; exit 1'],
    ["prints the PID and then hangs until it is cut off", 'echo "pid = 4242"; sleep 8'],
  ])("a confirmation that %s is not one: not ready (1)", (_label, later) => {
    plist("io.jobradar.ai-worker");
    // the first launchctl call answers at once; every later one (the confirmation) prints the PID, then goes wrong
    write(
      path.join(bin, "launchctl"),
      `#!/bin/bash\necho "launchctl $*" >> "${state}/calls"\nif [[ -e "${state}/answered" ]]; then ${later}; fi\ntouch "${state}/answered"\necho "pid = 4242"\n`,
      0o755,
    );
    const r = run(`ai_worker_wait_ready "${main()}" 1 2026-01-01T00:00:00Z 2; echo "rc=$?"`, env);
    expect(r.stdout.trim()).toBe("rc=1");
    expect(calls().some((c) => c.startsWith("node "))).toBe(true);
  });
});
