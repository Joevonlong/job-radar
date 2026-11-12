// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
const SCRIPT = path.join(ROOT, "scripts/mcp-stdio.sh");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A stub pnpm that reports where and how it was started on stderr.
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\necho "cwd=$(pwd -P) args=$*" >&2\n', { mode: 0o755 });

function run(command: string, env: Partial<NodeJS.ProcessEnv>) {
  return spawnSync(command, ["--extra"], { cwd: tmp, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
}

describe("scripts/mcp-stdio.sh", () => {
  it("runs pnpm from the project root, started through a symlink, with an empty stdout (even with CDPATH set)", () => {
    const link = path.join(tmp, "job-radar-mcp");
    fs.symlinkSync(SCRIPT, link);
    const r = run(link, { PATH: `${bin}:/usr/bin:/bin`, CDPATH: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`cwd=${ROOT}`);
    expect(r.stderr).toContain("args=--silent mcp:serve --extra");
  });

  it("says on stderr that pnpm is missing and exits non-zero", () => {
    const r = run(SCRIPT, { PATH: "/usr/bin:/bin" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("pnpm was not found");
    expect(r.stderr).toContain("docs/mcp.md");
  });
});
