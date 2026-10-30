// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_NAMES, configRegistry } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

interface Report {
  files: { name: string; file: string; layer: string; hash: string | null; error: string | null }[];
}

describe("pnpm config:check --effective", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
  });
  afterEach(() => tmp.cleanup());

  const report = (): Report => {
    const run = runConfigScript(tmp, "config-check.ts", ["--effective", "--json"]);
    expect(run.status, run.out).toBe(0);
    return JSON.parse(run.out) as Report;
  };
  const hashOf = (r: Report, name: string): string | null => r.files.find((file) => file.name === name)?.hash ?? null;

  it("prints one canonical hash per config file, and skips missing profile files", () => {
    const r = report();
    expect(r.files.map((file) => file.name)).toEqual(CONFIG_NAMES);
    for (const file of r.files) {
      if (configRegistry[file.name as keyof typeof configRegistry].location === "profile") expect(file).toMatchObject({ layer: "missing", hash: null });
      else expect(file.hash, file.name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(r.files.find((file) => file.name === "schedule")?.layer).toBe("user");
    expect(r.files.find((file) => file.name === "models")?.layer).toBe("default");
  });

  it("keeps the hash through comments, key order and an equal user copy; changes it with a value", () => {
    const before = report();
    const file = path.join(tmp.configDir, "schedule.yaml");
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `# a new comment\n${text}`);
    // a user copy of a shipped file with the same content: same effective value
    fs.copyFileSync(path.join(tmp.defaultsDir, "models.yaml"), path.join(tmp.configDir, "models.yaml"));
    const same = report();
    expect(hashOf(same, "schedule")).toBe(hashOf(before, "schedule"));
    expect(hashOf(same, "models")).toBe(hashOf(before, "models"));
    fs.writeFileSync(file, text.replace(/keep_daily: \d+/, "keep_daily: 99"));
    expect(hashOf(report(), "schedule")).not.toBe(hashOf(before, "schedule"));
  });

  it("names an invalid file and exits 1", () => {
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), "push_min_score: [oops\n");
    const run = runConfigScript(tmp, "config-check.ts", ["--effective"]);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`✗ ${path.join(tmp.configDir, "notify.yaml")} (user)`);
    expect(run.out).toMatch(new RegExp(`✓ ${path.join(tmp.configDir, "schedule.yaml").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(user\\) {2}[0-9a-f]{64}`));
  });
});
