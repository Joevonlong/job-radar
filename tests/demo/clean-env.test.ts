import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { blankEnv, envExampleNames } from "../../e2e-demo/clean-env";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("clean environment for the demo server", () => {
  it("reads set and commented-out names", () => {
    expect(envExampleNames("# comment\nA_KEY=\n# B_TOKEN=xyz\n  #C_URL=http://x\nlower=1\n")).toEqual(["A_KEY", "B_TOKEN", "C_URL"]);
  });

  it("blanks every variable of .env.example and the database / config ones", () => {
    const env = blankEnv(ROOT);
    const names = envExampleNames(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8"));
    expect(names.length).toBeGreaterThan(5);
    for (const name of [...names, "DATABASE_URL", "JOB_RADAR_WEB_PASSWORD", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR"]) expect(env[name]).toBe("");
  });
});
