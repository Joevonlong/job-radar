// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { nodeRequirementError } from "../../scripts/ops/require-node.mjs";

const RANGE = ">=26.13.1 <27";

describe("host command Node preflight", () => {
  it("allows the minimum version and gives an actionable error outside the range", () => {
    expect(nodeRequirementError(RANGE, "26.13.1")).toBeNull();
    expect(nodeRequirementError(RANGE, "26.13.0")).toBe(
      'Job Radar needs Node 26.13.1 or a later 26.x (engines.node ">=26.13.1 <27"); this is Node 26.13.0. Install it, then retry.',
    );
  });

  it("reads the package next to the preflight and exits before the following import runs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "require-node-"));
    try {
      const ops = path.join(root, "scripts/ops");
      mkdirSync(ops, { recursive: true });
      for (const name of ["require-node.mjs", "check-node-engines.mjs"]) {
        copyFileSync(path.resolve(import.meta.dirname, "../../scripts/ops", name), path.join(ops, name));
      }
      const major = Number(process.versions.node.split(".")[0]) + 1;
      const range = `>=${major}.0.0 <${major + 1}`;
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ engines: { node: range } }));
      const marker = path.join(root, "marker.mjs");
      writeFileSync(marker, 'console.log("marker ran")');
      const result = spawnSync(process.execPath, ["--import", path.join(ops, "require-node.mjs"), "--import", marker, "-e", ""], {
        cwd: import.meta.dirname,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `Job Radar needs Node ${major}.0.0 or a later ${major}.x (engines.node "${range}"); this is Node ${process.versions.node}. Install it, then retry.\n`,
      );
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
