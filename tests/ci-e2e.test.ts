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
    "runs-on": z.string(),
    env: z.record(z.string(), z.string()).optional(),
    services: z.record(z.string(), z.unknown()).optional(),
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
    for (const job of ["integration", "integration-shuffled", "worker-switch", "e2e", "linux-smoke"]) {
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

describe("independent slow CI jobs", () => {
  it("keeps integration setup and coverage while running the shuffled pass on its own runner", () => {
    const integration = workflow.jobs.integration!;
    const shuffled = workflow.jobs["integration-shuffled"]!;
    expect(shuffled.name).toBe("integration (shuffled)");
    expect(shuffled.needs).toBe("changes");
    expect(shuffled.needs).toBe(integration.needs);
    expect(shuffled.if).toBe("needs.changes.outputs.code == 'true'");
    expect(shuffled.if).toBe(integration.if);
    expect(shuffled["runs-on"]).toBe(integration["runs-on"]);
    expect(shuffled.env).toEqual(integration.env);
    expect(shuffled.services).toEqual(integration.services);
    const setupEnd = integration.steps.findIndex((step) => step.name === "Integration tests (default order)");
    expect(shuffled.steps.slice(0, setupEnd)).toEqual(integration.steps.slice(0, setupEnd));
    expect(integration.steps.find((step) => step.name === "Integration tests (default order)")?.if).toBe("needs.changes.outputs.full == 'true'");
    expect(integration.steps.some((step) => step.name === "Integration tests (shuffled file order)")).toBe(false);
    expect(integration.steps.slice(-2).map((step) => step.name)).toEqual([
      "Set up the lowest Node.js of engines.node", "Load a release module with the lowest Node.js",
    ]);
    const test = shuffled.steps.at(-1)!;
    expect(test.name).toBe("Integration tests (shuffled file order)");
    expect(test.if).toBeUndefined();
    expect(test.run).toContain('--sequence.shuffle.files --sequence.seed="$seed"');
    for (const job of [integration, shuffled]) {
      const run = job.steps.find((step) => step.name.startsWith("Integration tests"))!.run!;
      expect(run).toContain('--exclude "tests/integration/ai-worker-swap.test.ts"');
      expect(run).toContain('--exclude "tests/integration/uninstall-ai-worker.test.ts"');
    }
  });

  it("runs transition A and B on separate runners with exact deploy evidence names and distinct logs", () => {
    const job = workflow.jobs["upgrade-transition"]!;
    expect(job.name).toBe("upgrade-transition (${{ matrix.scenario }})");
    expect(job.strategy).toEqual({ "fail-fast": false, matrix: { scenario: ["A", "B"] } });
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.transition == 'true'");
    expect(job["timeout-minutes"]).toBe(120);
    expect(job.env?.SCENARIO).toBe("${{ matrix.scenario }}");
    expect(job.steps[0]?.with?.["fetch-depth"]).toBe(0);
    const launch = job.steps.find((step) => step.name === "Start transition scenarios")!;
    expect(launch.run).toContain('for shard in "$SCENARIO"; do');
    expect(launch.run).toContain('bash tests/transition/run.sh --scenarios "$shard" "$state/$shard/artifacts"');
    for (const scenario of ["A", "B"]) {
      const step = job.steps.find((step) => step.name === `Transition scenario ${scenario}`)!;
      expect(step.if).toBe(`\${{ !cancelled() && matrix.scenario == '${scenario}' }}`);
      expect(step["timeout-minutes"]).toBe(66);
      const upload = job.steps.find((step) => step.name === `Upload the transition logs (scenario ${scenario})`)!;
      expect(upload.if).toBe(`\${{ failure() && matrix.scenario == '${scenario}' && env.TRANSITION_STATE != '' }}`);
      expect(upload.with?.name).toBe(`upgrade-transition-logs-${scenario}`);
      expect(upload.with?.path).toContain(`/${scenario}.log`);
      expect(upload.with?.path).toContain(`/${scenario}/artifacts/`);
      expect(upload.with?.["retention-days"]).toBe(7);
    }
    expect(job.steps.find((step) => step.name === "Clean up transition scenarios")?.if).toBe("always()");
  });
});

describe("ci-ok slow job gating", () => {
  const gate = workflow.jobs["ci-ok"]!;
  const needs = z.array(z.string()).parse(gate.needs);
  const command = z.string().parse(gate.steps[0]?.run);

  it("requires every workflow job, including both aggregate matrices and the shuffled pass", () => {
    expect([...needs].sort()).toEqual(Object.keys(workflow.jobs).filter((id) => id !== "ci-ok").sort());
    expect(gate.if).toBe("always()");
  });

  it.each(["integration", "integration-shuffled", "upgrade-transition"].flatMap((job) =>
    ["true", "false"].flatMap((selected) => ["success", "failure", "skipped", "cancelled"].map((result) => ({
      job, selected, result, status: result === (selected === "true" ? "success" : "skipped") ? 0 : 1,
    }))),
  ))("$job selected=$selected result=$result exits $status", ({ job, selected, result, status }) => {
    const code = job === "upgrade-transition" ? "true" : selected;
    const transition = job === "upgrade-transition" ? selected : "false";
    const results = Object.fromEntries(needs.map((id) => [id, {
      result: ["changes", "ci-docs", "static", "unit"].includes(id) || code === "true" ? "success" : "skipped",
    }]));
    const changes = { ...results.changes, outputs: { code, transition } };
    results["upgrade-transition"] = { result: transition === "true" ? "success" : "skipped" };
    results[job] = { result };
    const out = spawnSync("/bin/bash", ["-e", "-c", command], {
      env: { ...process.env, NEEDS: JSON.stringify({ ...results, changes }) }, encoding: "utf8", timeout: 10_000,
    });
    expect(out.status, out.stdout + out.stderr).toBe(status);
  });
});
