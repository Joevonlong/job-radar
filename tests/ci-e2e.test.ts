// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflow = z.object({
  jobs: z.record(z.string(), z.object({
    name: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    "timeout-minutes": z.number().positive(),
    strategy: z.object({
      "fail-fast": z.boolean().optional(),
      matrix: z.record(z.string(), z.array(z.union([z.string(), z.number()]))),
    }).optional(),
    steps: z.array(z.object({
      name: z.string(),
      "timeout-minutes": z.number().positive(),
      uses: z.string().optional(),
      run: z.string().optional(),
      if: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      with: z.record(z.string(), z.unknown()).optional(),
    })),
  })),
}).parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")));

describe("e2e CI parts", () => {
  const e2e = workflow.jobs.e2e!;

  it("runs both parts independently and keeps the setup wizard in the parallel part", () => {
    expect(e2e.name).toBe("e2e (${{ matrix.part }})");
    expect(e2e.strategy).toEqual({ "fail-fast": false, matrix: { part: ["parallel", "chain"] } });
    expect(e2e.needs).toBe("changes");
    expect(e2e.if).toBe("needs.changes.outputs.code == 'true'");
    const main = e2e.steps.find((step) => step.name === "End-to-end tests")!;
    expect(main.env?.E2E_PART).toBe("${{ matrix.part }}");
    expect(main.run).toBe("pnpm test:e2e --workers=2 --fail-on-flaky-tests");
    const setup = e2e.steps.find((step) => step.name === "Setup wizard end-to-end tests")!;
    expect(setup.if).toBe("matrix.part == 'parallel'");
    expect(setup.run).toBe("pnpm test:e2e:setup --fail-on-flaky-tests");
  });

  it("keeps failure reports from the two parts separate", () => {
    const upload = e2e.steps.find((step) => step.name === "Upload the Playwright report and traces")!;
    expect(upload.if).toBe("failure()");
    expect(upload.with?.name).toBe("playwright-report-${{ matrix.part }}");
    expect(upload.with?.path).toContain("playwright-report/");
    expect(upload.with?.path).toContain("playwright-report-setup/");
    expect(upload.with?.path).toContain("test-results/");
  });

  it("keeps timeouts on every job and step and full SHA pins on every action", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      for (const step of job.steps) {
        expect(step["timeout-minutes"]).toBeGreaterThan(0);
        if (step.uses) expect(step.uses).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      }
    }
  });
});

describe("ci-ok e2e aggregate gating", () => {
  const gate = workflow.jobs["ci-ok"]!;
  const needs = z.array(z.string()).parse(gate.needs);
  const command = z.string().parse(gate.steps.find((step) => step.name === "All selected checks passed")?.run);

  it("waits for the e2e matrix even when it fails or is skipped", () => {
    expect(needs).toContain("e2e");
    expect(gate.if).toBe("always()");
  });

  it.each([
    { code: "true", e2e: "success", status: 0 },
    { code: "true", e2e: "failure", status: 1 },
    { code: "true", e2e: "skipped", status: 1 },
    { code: "true", e2e: "cancelled", status: 1 },
    { code: "false", e2e: "skipped", status: 0 },
    { code: "false", e2e: "success", status: 1 },
    { code: "false", e2e: "failure", status: 1 },
    { code: "false", e2e: "cancelled", status: 1 },
  ])("code=$code and aggregate e2e=$e2e exits $status", ({ code, e2e, status }) => {
    const results: Record<string, { result: string; outputs?: Record<string, string> }> = Object.fromEntries(
      needs.map((job) => [job, { result: "success" }]),
    );
    results.changes = { result: "success", outputs: { code, transition: "false" } };
    for (const job of ["integration", "worker-switch", "e2e", "linux-smoke"]) {
      results[job] = { result: code === "true" ? "success" : "skipped" };
    }
    results.e2e = { result: e2e };
    results["upgrade-transition"] = { result: "skipped" };
    // Execute the workflow's exact gate; no second implementation of its selected/skipped rules.
    const out = spawnSync("/bin/bash", ["-e", "-c", command], {
      env: { ...process.env, NEEDS: JSON.stringify(results) }, encoding: "utf8", timeout: 10_000,
    });
    expect(out.status, out.stdout + out.stderr).toBe(status);
  });
});
