// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The config commands read `.env` themselves, with a flag that never overrides what the caller already set.
 * `deploy.sh` points the write step at the database by a prefix assignment on the command, so the assignment must
 * win over `.env` and nothing may go through `env DATABASE_URL=...`.
 */
const REPO = path.resolve(import.meta.dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
const DEPLOY = fs.readFileSync(path.join(REPO, "scripts/ops/deploy.sh"), "utf8");

describe("package.json config scripts", () => {
  it.each(["config:init", "config:migrate", "config:example", "config:plan"])("%s loads .env without overriding the environment", (name) => {
    const script = pkg.scripts[name];
    expect(script, name).toBeDefined();
    expect(script).toMatch(/^node --env-file-if-exists=\.env --import tsx scripts\/[\w-]+\.ts\b/);
    // the overriding variant would let .env beat the caller's DATABASE_URL
    expect(script).not.toContain("--env-file=");
    expect(script).not.toMatch(/dotenv/);
  });

  it("every script it points to exists", () => {
    for (const name of ["config:init", "config:migrate", "config:example", "config:plan"]) {
      const file = /(scripts\/[\w-]+\.ts)/.exec(pkg.scripts[name] ?? "")?.[1];
      expect(file, name).toBeDefined();
      expect(fs.existsSync(path.join(REPO, file ?? "")), file).toBe(true);
    }
  });
});

describe("deploy.sh points the write step at the database", () => {
  it("does it with a prefix assignment, in one place", () => {
    const assignments = DEPLOY.split("\n").filter((line) => /DATABASE_URL="\$CONFIG_WRITE_DB_URL"/.test(line));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatch(/^\s*DATABASE_URL="\$CONFIG_WRITE_DB_URL" proc_run "\$@"/);
  });

  it("never goes through `env DATABASE_URL=`", () => {
    expect(DEPLOY).not.toMatch(/\benv\s+(-\S+\s+)*DATABASE_URL=/);
    expect(DEPLOY).not.toContain("env DATABASE_URL");
  });

  it("runs every pnpm config:* write command of the gated step through the wrapper", () => {
    const lines = DEPLOY.split("\n");
    // the branch for targets without a config-write step runs their own original commands; the gate does not exist there
    const legacyStart = lines.findIndex((line) => /CONFIG_WRITE_STEP"\s*==\s*0/.test(line));
    const legacyEnd = lines.findIndex((line, index) => index > legacyStart && /^else\b/.test(line));
    expect(legacyStart).toBeGreaterThanOrEqual(0);
    expect(legacyEnd).toBeGreaterThan(legacyStart);
    const writes = lines.filter((line, index) => (index < legacyStart || index > legacyEnd) && /\bpnpm config:(migrate --write|init|migrate --prune-backups)\b/.test(line) && !/^\s*(#|echo|say)/.test(line));
    // the step-4 `--env-only` run writes only .env and the data folders, not user config files
    const gated = writes.filter((line) => !line.includes("--env-only"));
    expect(gated.length).toBe(4); // two forms of migrate --write: with the conversion, and for a target without it
    for (const line of gated) expect(line.trim(), line).toMatch(/^config_write_run pnpm /);
  });
});
