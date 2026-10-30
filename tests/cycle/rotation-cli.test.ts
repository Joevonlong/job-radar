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

it("prints company queries in a fixture-backed dry run and in the source-list JSON", () => {
  const tmp = makeTempConfig();
  const root = path.resolve(import.meta.dirname, "../..");
  try {
    const interests = path.join(tmp.configDir, "interests.yaml");
    const watch = parseDocument(fs.readFileSync(interests, "utf8"));
    watch.set("watched_companies", ["Probe Industries"]);
    fs.writeFileSync(interests, watch.toString());
    const language = path.join(tmp.configDir, "language.yaml");
    const words = parseDocument(fs.readFileSync(language, "utf8"));
    words.setIn(["cli", "locale"], "en");
    fs.writeFileSync(language, words.toString());
    const bootstrap = path.join(tmp.root, "company-channel.mjs");
    fs.writeFileSync(bootstrap, `
      import { createFixtureChannel, FIXTURE_SETTINGS } from ${JSON.stringify(path.join(root, "src/lib/channels/fixture/index.ts"))};
      import { defaultRegistry } from ${JSON.stringify(path.join(root, "src/lib/channels/registry.ts"))};
      defaultRegistry.register({ ...createFixtureChannel({ id: "company-probe", postings: [] }), supportsCompanyQueries: true }, { settings: FIXTURE_SETTINGS });
    `);
    const env = { ...process.env, DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/jobradar_test_cli", DB_CONNECT_TIMEOUT_SECONDS: "1" };
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", bootstrap, "scripts/cycle-run.ts", "--channel", "company-probe", "--dry-run"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Company queries:");
    expect(result.stdout).toContain("Company: Probe Industries");
    expect(result.stdout).toContain("keywordGroup=company:probe-industries");
    const list = spawnSync(process.execPath, ["--import", "tsx", "scripts/sources-list.ts", "--json", "--lang", "en"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout).companyQueries).toEqual([expect.objectContaining({ company: { name: "Probe Industries", key: "probe-industries" } })]);
  } finally { tmp.cleanup(); }
});
