// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflow = z.object({ jobs: z.record(z.string(), z.object({
  steps: z.array(z.object({ name: z.string(), run: z.string().optional() })),
})) }).parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")));

const jobs = [
  { job: "worker-switch", start: "Start worker switch shards", waits: ["Worker switch (systemd)", "Worker switch (launchd)"], cleanup: "Clean up worker switch shards", state: "WORKER_SWITCH_STATE", shards: ["systemd", "launchd"] },
  { job: "upgrade-transition", start: "Start transition scenarios", waits: ["Transition scenario A", "Transition scenario B"], cleanup: "Clean up transition scenarios", state: "TRANSITION_STATE", shards: ["A", "B"] },
];

function snippet(job: string, name: string): string {
  return z.string().parse(workflow.jobs[job]?.steps.find((step) => step.name === name)?.run);
}

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("dummy shard did not reach its expected state");
}

/** Execute the exact YAML snippets. PATH stubs replace only external commands, never their process supervision. */
function fixture(job: typeof jobs[number], firstMode: string, secondMode: string) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-")));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(bin, file), text, { mode: 0o755 });
  write("df", "#!/bin/sh\necho 'dummy disk snapshot'\n");
  write("free", "#!/bin/sh\necho 'dummy memory snapshot'\n");
  write("cat", '#!/bin/bash\nif [[ "${1##*/}" == started ]]; then echo ready > "$DUMMY_ROOT/wait-ready"; fi\nexec /bin/cat "$@"\n');
  write("docker", "#!/bin/sh\n[ \"$*\" = 'system df' ] || exit 99\necho 'dummy docker snapshot'\n");
  // Preserve bash -c for the wrapper, but replace run.sh with the same dummy used for pnpm.
  write("bash", '#!/bin/bash\nif [[ "$1" == tests/transition/run.sh ]]; then exec "$DUMMY_COMMAND" "$@"; fi\nexec /bin/bash "$@"\n');
  write("pnpm", '#!/bin/bash\nexec "$DUMMY_COMMAND" "$@"\n');
  write("dummy", `#!/bin/bash
if [[ -n "$SWAP_MANAGERS" ]]; then shard=$SWAP_MANAGERS; else shard=$3; fi
mode=$DUMMY_SECOND_MODE
[[ "$shard" != "$DUMMY_FIRST_SHARD" ]] || mode=$DUMMY_FIRST_MODE
printf '%s\\n' "$*" > "$DUMMY_ROOT/$shard.args"
echo "dummy $shard log"
trap 'echo cleaned > "$DUMMY_ROOT/$shard.cleaned"; exit 143' TERM
echo ready > "$DUMMY_ROOT/$shard.ready"
case "$mode" in
  success) exit 0 ;;
  failure) exit 7 ;;
  missing) kill -KILL "$PPID" ;; # no wrapper remains to publish an exit-code file
  block) ;;
  *) exit 99 ;;
esac
sleep 300 &
echo "$!" > "$DUMMY_ROOT/$shard.child"
wait "$!"
`);
  const output = path.join(tmp, "env");
  fs.writeFileSync(output, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: tmp, GITHUB_ENV: output,
    DUMMY_COMMAND: path.join(bin, "dummy"), DUMMY_ROOT: tmp,
    DUMMY_FIRST_SHARD: job.shards[0], DUMMY_FIRST_MODE: firstMode, DUMMY_SECOND_MODE: secondMode,
  };
  // The transition process must use its scenario argument even if a developer exported this local test filter.
  delete env.SWAP_MANAGERS;
  const args = (name: string) => ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", snippet(job.job, name)];
  const run = (name: string) => spawnSync("/bin/bash", args(name), { env, encoding: "utf8", timeout: 15_000 });
  const start = run(job.start);
  expect(start.status, start.stdout + start.stderr).toBe(0);
  const state = fs.readFileSync(output, "utf8").trim().slice(job.state.length + 1);
  env[job.state] = state;
  return {
    tmp, state, run,
    waitProcess: () => {
      fs.rmSync(path.join(tmp, "wait-ready"), { force: true });
      return spawn("/bin/bash", args(job.waits[0]!), { env, stdio: "ignore" });
    },
    ready: () => job.shards.every((shard) => fs.existsSync(path.join(tmp, `${shard}.ready`))),
    dispose() {
      try {
        const result = run(job.cleanup);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        // Check the recorded grandchildren too: killing just the wrapper would leave these alive.
        for (const shard of job.shards) {
          const file = path.join(tmp, `${shard}.child`);
          if (!fs.existsSync(file)) continue;
          const pid = fs.readFileSync(file, "utf8").trim();
          try {
            process.kill(Number(pid), 0);
            throw new Error(`child ${pid} still running`);
          } catch (error) {
            expect(error).toHaveProperty("code", "ESRCH");
          }
        }
      } finally {
        for (const shard of job.shards) {
          const pidFile = path.join(state, `${shard}.pid`);
          if (!fs.existsSync(pidFile)) continue;
          try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already exited */ }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

describe.each(jobs)("$job workflow processes", (job) => {
  it("reports both a failed first shard and a successful second shard independently", async () => {
    const fx = fixture(job, "failure", "success");
    try {
      await until(fx.ready);
      const first = fx.run(job.waits[0]!);
      expect(first.status, first.stdout + first.stderr).toBe(1);
      expect(first.stdout).toContain("exit code 7");
      expect(first.stdout).toContain(`dummy ${job.shards[0]} log`);
      const second = fx.run(job.waits[1]!);
      expect(second.status, second.stdout + second.stderr).toBe(0);
      expect(second.stdout).toContain(`dummy ${job.shards[1]} log`);
      expect(second.stdout).not.toContain(`dummy ${job.shards[0]} log`);
      if (job.job === "upgrade-transition") {
        for (const shard of job.shards) {
          expect(fs.readFileSync(path.join(fx.tmp, `${shard}.args`), "utf8")).toContain(`--scenarios ${shard} ${fx.state}/${shard}/artifacts`);
        }
      }
    } finally { fx.dispose(); }
  });

  it("does not wait for the other shard and rejects a missing exit-code file", async () => {
    const fx = fixture(job, "success", "missing");
    try {
      await until(fx.ready);
      expect(fx.run(job.waits[0]!).status).toBe(0);
      const missing = fx.run(job.waits[1]!);
      expect(missing.status, missing.stdout + missing.stderr).toBe(1);
      expect(missing.stdout).toContain("without an exit-code file");
      expect(fs.existsSync(path.join(fx.state, `${job.shards[1]}.exit`))).toBe(false);
    } finally { fx.dispose(); }
  });

  it("fails a live shard with no status when its launch-time deadline expires", async () => {
    const fx = fixture(job, "block", "block");
    try {
      await until(fx.ready);
      fs.writeFileSync(path.join(fx.state, "started"), "0\n");
      for (const name of job.waits) {
        const result = fx.run(name);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).toContain("timed out without an exit-code file");
      }
    } finally { fx.dispose(); }
  });

  it("forwards cancellation to a shard's trap and cleanup stops the other process group", async () => {
    const fx = fixture(job, "block", "block");
    try {
      await until(fx.ready);
      const waiter = fx.waitProcess();
      const done = new Promise<number | null>((resolve) => waiter.once("close", resolve));
      // Reading the launch timestamp happens after the wait shell installed its signal traps.
      await until(() => fs.existsSync(path.join(fx.tmp, "wait-ready")));
      waiter.kill("SIGINT");
      expect(await done).toBe(130);
      await until(() => fs.existsSync(path.join(fx.tmp, `${job.shards[0]}.cleaned`)));
      expect(fx.run(job.cleanup).status).toBe(0);
      for (const shard of job.shards) expect(fs.existsSync(path.join(fx.tmp, `${shard}.cleaned`))).toBe(true);
    } finally { fx.dispose(); }
  });
});
