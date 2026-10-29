// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";
import { parseDocument } from "yaml";

import { makeTempConfig } from "../config/helpers";

it("prints the config-order explanation once for a fixture dry run", () => {
  const tmp = makeTempConfig();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cycle-run.ts", "--channel", "fixture", "--dry-run"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/jobradar_test_cli", DB_CONNECT_TIMEOUT_SECONDS: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("  query order:"))).toEqual([
      "  query order: config order (dry runs do not read run history; real runs rotate by history)",
    ]);
  } finally {
    tmp.cleanup();
  }
});

it("prints the rotation-off explanation exactly once for a dry run using a user override", () => {
  const tmp = makeTempConfig();
  try {
    const file = path.join(tmp.configDir, "sources.yaml");
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    doc.setIn(["collect", "query_rotation"], false);
    fs.writeFileSync(file, doc.toString());
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cycle-run.ts", "--channel", "fixture", "--dry-run"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/jobradar_test_cli", DB_CONNECT_TIMEOUT_SECONDS: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("  query order:"))).toEqual([
      "  query order: config order (collect.query_rotation is false)",
    ]);
    expect(result.stdout).not.toContain("real runs rotate by history");
  } finally {
    tmp.cleanup();
  }
});
