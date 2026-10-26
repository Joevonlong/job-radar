// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

// Execute the workflow's rule itself: a second implementation here would let the two drift apart.
const workflow = z.object({
  jobs: z.object({
    changes: z.object({ steps: z.array(z.object({ id: z.string().optional(), run: z.string().optional() })) }),
  }),
}).parse(parse(fs.readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8")));
const classifier = z.string().parse(workflow.jobs.changes.steps.find((step) => step.id === "diff")?.run);

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-classifier-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  // --no-renames lists deletions and both sides of a rename as plain paths, one per line, without status columns.
  // Refuse another invocation so the cases exercise the same diff format as CI.
  fs.writeFileSync(path.join(tmp, "bin/git"), `#!/usr/bin/env bash
[[ "$#" == 4 && "$1" == diff && "$2" == --name-only && "$3" == --no-renames && "$4" == base...head ]] || exit 2
printf '%s\\n' "$CLASSIFIER_PATHS"
exit "\${CLASSIFIER_DIFF_STATUS:-0}"
`, { mode: 0o755 });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function classify(paths: string[], event = "pull_request", diffStatus = 0) {
  const output = path.join(tmp, "output");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", classifier], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
      EVENT: event, PR_BASE: "base", PR_HEAD: "head", GITHUB_OUTPUT: output,
      CLASSIFIER_PATHS: paths.join("\n"), CLASSIFIER_DIFF_STATUS: String(diffStatus),
    },
  });
  return { ...result, outputs: Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("="))) };
}

describe("CI change classification", () => {
  const cases = [
    { name: "documentation only", paths: ["README.md", "docs/guide.html", "docs/images/example.png"], code: false, full: false, transition: false },
    { name: "mixed documentation and code", paths: ["docs/guide.md", "src/runner/index.ts"], code: true, full: false, transition: false },
    { name: "a deleted code file", paths: ["src/deleted.ts"], code: true, full: false, transition: false },
    { name: "a deleted dependency manifest", paths: ["pnpm-workspace.yaml"], code: true, full: true, transition: true },
    { name: "rename from ops to documentation keeps the old path", paths: ["docs/moved.md", "scripts/ops/old.sh"], code: true, full: false, transition: true },
    { name: "rename into ops includes the new path", paths: ["docs/old.md", "scripts/ops/moved.sh"], code: true, full: false, transition: true },
    { name: "rename of code to documentation", paths: ["docs/moved.md", "src/old.ts"], code: true, full: false, transition: false },
    { name: "rename between documentation files", paths: ["docs/new.md", "docs/old.md"], code: false, full: false, transition: false },
    ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/ci.yml", ".github/dependabot.yml", ".github/README.md", "vitest.config.ts", "vitest.integration.config.ts", "playwright.config.ts", "playwright.setup.config.ts", ".nvmrc", ".node-version"].map((file) => ({
      name: `toolchain: ${file}`, paths: [file], code: true, full: true, transition: true,
    })),
    ...["scripts/ops/deploy.sh", "src/ai-worker/index.ts", "tests/transition/run.sh", "tests/ops/sim/systemctl", "Dockerfile", "compose.yaml"].map((file) => ({
      name: `deployment: ${file}`, paths: [file], code: true, full: false, transition: true,
    })),
    ...["tests/fixtures/example.html", "src/example.svg", "public/example.png", "unrecognised/path", "future.config.yaml"].map((file) => ({
      name: `code or unknown: ${file}`, paths: [file], code: true, full: false, transition: false,
    })),
  ];

  it.each(cases)("$name", ({ paths, code, full, transition }) => {
    const result = classify(paths);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.outputs).toEqual({ code: String(code), full: String(full), transition: String(transition) });
  });

  it.each(["push", "workflow_dispatch"])("%s always selects everything, even for documentation", (event) => {
    const result = classify(["README.md"], event);
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toEqual({ code: "true", full: "true", transition: "true" });
  });

  it("fails when git cannot compute the diff instead of publishing a selection", () => {
    const result = classify([], "pull_request", 128);
    expect(result.status).toBe(128);
    expect(result.outputs).toEqual({});
  });
});
