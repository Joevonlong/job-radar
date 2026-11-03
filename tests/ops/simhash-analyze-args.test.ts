// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

function run(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), "scripts/simhash-analyze.ts", ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stderr: r.stderr };
}

describe("simhash:analyze numeric arguments", () => {
  it.each([["--max", "abc"], ["--seed", "1.5"], ["--same-title-max", "x3"], ["--max", ""]])("%s %s is refused before anything runs", (flag, value) => {
    const r = run([`${flag}=${value}`, "--guard", "--input", "/nonexistent/snapshot.json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${flag} needs a whole number`);
  });
});
