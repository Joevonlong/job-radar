// @vitest-environment node
import * as childProcess from "node:child_process";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { aiWorkerLaunchdLabel } from "@/lib/ops/ai-worker-label";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw new Error("label resolution must not spawn a process"); }),
}));

const lib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/ai-worker.sh");
const shell = (command: string, args: string[] = []) => childProcess.spawnSync("/bin/bash", ["-c", 'source "$1" && shift && ' + command, "label-parity", lib, ...args], {
  encoding: "utf8", timeout: 10_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
});

it("keeps the shell and TypeScript label rules in parity without spawning from TypeScript", () => {
  const defaultLabel = shell('printf "%s" "$AI_WORKER_DEFAULT_LABEL"');
  expect(defaultLabel.status, defaultLabel.stderr).toBe(0);
  expect(defaultLabel.stdout).not.toBe("");
  const cases = [
    { input: undefined, valid: true },
    { input: "", valid: true },
    { input: "io.jobradar.ai-worker", valid: true },
    { input: "de.jobradar.ai-worker", valid: true },
    { input: "org.example.worker_2-Blue", valid: true },
    ...["invalid label", "../worker", "worker\n", "worker\r", "worker\r\n", "工作器", "$(id)"].map((input) => ({ input, valid: false })),
  ];
  for (const { input, valid } of cases) {
    const result = shell('ai_worker_resolve_launchd_label "$@"', input === undefined ? [] : [input]);
    expect(result.status === 0, JSON.stringify(input)).toBe(valid);
    if (valid) {
      expect(result.stdout).toBe(input || defaultLabel.stdout);
      expect(aiWorkerLaunchdLabel(input)).toBe(result.stdout);
    } else {
      expect(result.stderr).toContain("doctor.ai_worker_launchd_label");
      expect(() => aiWorkerLaunchdLabel(input)).toThrow(/doctor.ai_worker_launchd_label/);
    }
  }
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
});
