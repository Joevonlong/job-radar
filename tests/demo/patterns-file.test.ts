import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPrivateStrings, MissingPatternsError, privateStringsFile } from "../../e2e-demo/guard";

let dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patterns-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("private patterns file", () => {
  it("is found in the main checkout when a worktree has none", () => {
    const worktree = tempDir();
    const main = tempDir();
    fs.writeFileSync(path.join(main, ".release-check.local"), "# comment\nalpha-private\nbeta-private\n");
    expect(privateStringsFile(worktree, {}, main)).toBe(path.join(main, ".release-check.local"));
    expect(loadPrivateStrings(worktree, { require: true, env: {}, mainCheckout: main }).strings).toEqual(["alpha-private", "beta-private"]);
  });

  it("prefers the environment variable, then the repository's own file", () => {
    const repo = tempDir();
    const main = tempDir();
    fs.writeFileSync(path.join(repo, ".release-check.local"), "x\n");
    fs.writeFileSync(path.join(main, ".release-check.local"), "y\n");
    expect(privateStringsFile(repo, {}, main)).toBe(path.join(repo, ".release-check.local"));
    expect(privateStringsFile(repo, { RELEASE_CHECK_PATTERNS_FILE: "/elsewhere/p.txt" }, main)).toBe("/elsewhere/p.txt");
  });

  it("fails when required and missing, and warns otherwise", () => {
    const repo = tempDir();
    expect(() => loadPrivateStrings(repo, { require: true, env: {}, mainCheckout: undefined })).toThrow(MissingPatternsError);
    const warn = vi.fn();
    expect(loadPrivateStrings(repo, { require: false, env: {}, mainCheckout: undefined, warn }).strings).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });

  it("fails when required and the file is empty", () => {
    const repo = tempDir();
    fs.writeFileSync(path.join(repo, ".release-check.local"), "# only comments\n");
    expect(() => loadPrivateStrings(repo, { require: true, env: {}, mainCheckout: undefined })).toThrow(MissingPatternsError);
  });
});
