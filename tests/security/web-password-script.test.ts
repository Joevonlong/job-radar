// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parsePasswordHash, readPasswordSetting, verifyPassword } from "@/lib/security/password";

const root = path.resolve(import.meta.dirname, "../..");
const run = (input: string, args: string[] = ["--stdin"]) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/web-password.ts", ...args], { cwd: root, input, encoding: "utf8", env: { ...process.env, JOB_RADAR_LOCALE: "en" }, timeout: 60_000 });

describe("pnpm web:password --stdin", () => {
  it("prints exactly one .env line with a verifiable hash, and never the password", async () => {
    const r = run("a long test password\n");
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^JOB_RADAR_WEB_PASSWORD_HASH=scrypt:/);
    expect(`${r.stdout}${r.stderr}`).not.toContain("a long test password");
    const hash = (lines[0] ?? "").slice("JOB_RADAR_WEB_PASSWORD_HASH=".length);
    expect(parsePasswordHash(hash)).not.toBeNull();
    const setting = readPasswordSetting({ JOB_RADAR_WEB_PASSWORD_HASH: hash });
    if (setting === null) throw new Error("no setting");
    expect(await verifyPassword("a long test password", setting)).toBe(true);
  });

  it("refuses a short or empty password with exit code 2 and prints nothing on stdout", () => {
    for (const input of ["short\n", "\n", ""]) {
      const r = run(input);
      expect(r.status, JSON.stringify(input)).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  it("refuses unknown arguments", () => {
    expect(run("", ["--password", "x"]).status).toBe(2);
  });
});
