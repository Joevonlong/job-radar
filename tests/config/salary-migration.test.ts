// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { applyConfigMigrations, loadConfig, planConfigMigrations, validateConfigText } from "@/lib/config";
import { salary002 } from "@/lib/config/migrations/salary/002-drop-include-ai-lookups";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
const salaryText = (version: number | null = 1, includeKey = true): string => `# My salary settings
${version === null ? "" : `config_version: ${version}\n`}
benchmark:
  # Keep my window
  enabled: true
  window_days: 42 # custom window
  # Keep the sample comment
  min_sample: 7
${includeKey ? "  # Remove this obsolete switch\n  # And its explanation\n  include_ai_lookups: true\n" : ""}
# Keep my family
role_families:
  - id: custom_role
    label: {en: Custom role}
    patterns: [custom]
deep_links: []
lookup:
  enabled: false
  ttl_days: 12
  max_per_day: 2
  timeout_seconds: 30
  max_searches: 2
  allowed_fetch_domains: [levels.fyi]
  sanity_annual: {min: 1000, max: 999999}
`;

beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

describe("salary.yaml 1 -> 2", () => {
  it("loads an old file in memory, preserving custom settings and leaving the file untouched", () => {
    const file = path.join(tmp.configDir, "salary.yaml");
    const before = salaryText();
    fs.writeFileSync(file, before);
    const salary = loadConfig("salary");
    expect(salary.benchmark).toEqual({ enabled: true, window_days: 42, min_sample: 7 });
    expect(salary.role_families).toEqual([{ id: "custom_role", label: { en: "Custom role" }, patterns: ["custom"] }]);
    expect(salary.lookup.ttl_days).toBe(12);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("--write removes the key and its comments, keeps other values and comments, and is idempotent", async () => {
    const file = path.join(tmp.configDir, "salary.yaml");
    fs.writeFileSync(file, salaryText());
    const plan = planConfigMigrations(["salary"]);
    expect(plan.pending).toHaveLength(1);
    await applyConfigMigrations(plan);
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("config_version: 2");
    expect(after).not.toContain("include_ai_lookups");
    expect(after).not.toContain("Remove this obsolete switch");
    expect(after).not.toContain("And its explanation");
    for (const comment of ["My salary settings", "Keep my window", "custom window", "Keep the sample comment", "Keep my family"]) expect(after).toContain(comment);
    expect(validateConfigText("salary", after).ok).toBe(true);
    expect(loadConfig("salary").benchmark).toEqual({ enabled: true, window_days: 42, min_sample: 7 });
    const again = planConfigMigrations(["salary"]);
    expect(again.pending).toHaveLength(0);
    await applyConfigMigrations(again);
    expect(fs.readFileSync(file, "utf8")).toBe(after);
  });

  it.each([1, null])("migrates version %s with or without the obsolete key", async (version) => {
    const file = path.join(tmp.configDir, "salary.yaml");
    for (const includeKey of [false, true]) {
      fs.writeFileSync(file, salaryText(version, includeKey));
      await applyConfigMigrations(planConfigMigrations(["salary"]));
      const after = fs.readFileSync(file, "utf8");
      expect(after).toContain("config_version: 2");
      expect(after).not.toContain("include_ai_lookups");
      expect(validateConfigText("salary", after).ok).toBe(true);
    }
  });

  it("rejects the key in v2 with an unknown-key error", () => {
    const result = validateConfigText("salary", salaryText(2));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ path: "benchmark.include_ai_lookups", message: "unknown key", source: "schema" }));
  });

  it.each(["true", "false", "null", "{nested: true}", "!unset value"])("removes any value node: %s", (value) => {
    const doc = parseDocument(`config_version: 1\nbenchmark:\n  min_sample: 4 # keep inline\n  # obsolete\n  include_ai_lookups: ${value}\n  # keep next\n  window_days: 42\n`);
    expect(doc.errors).toHaveLength(0);
    salary002.migrate(doc);
    expect(doc.toJS()).toEqual({ config_version: 1, benchmark: { min_sample: 4, window_days: 42 } });
    const after = doc.toString();
    expect(after).not.toContain("obsolete");
    expect(after).toContain("keep inline");
    expect(after).toContain("keep next");
    salary002.migrate(doc);
    expect(doc.toString()).toBe(after);
  });

  it("removes the preceding empty value's trailing comment when YAML attaches the switch explanation there", () => {
    const doc = parseDocument("benchmark:\n  # keep above\n  min_sample:\n  # obsolete\n  include_ai_lookups: true\n  # keep next\n  window_days: 42\n");
    salary002.migrate(doc);
    expect(doc.toString()).not.toContain("obsolete");
    expect(doc.toString()).toContain("keep above");
    expect(doc.toString()).toContain("keep next");
    expect(doc.toJS()).toEqual({ benchmark: { min_sample: null, window_days: 42 } });
  });

  it.each(["", "  # obsolete\n  # obsolete explanation\n"])("keeps an empty preceding value's inline comment: %s", (explanation) => {
    const doc = parseDocument(`benchmark:\n  min_sample: # keep inline\n${explanation}  include_ai_lookups: true\n`);
    salary002.migrate(doc);
    expect(doc.toString()).toContain("keep inline");
    expect(doc.toString()).not.toContain("obsolete");
  });

  it("removes comments above the switch when it is the first benchmark key", () => {
    const doc = parseDocument("# keep section\nbenchmark:\n  # obsolete\n  include_ai_lookups: true\n  # keep setting\n  enabled: true\n");
    salary002.migrate(doc);
    expect(doc.toString()).not.toContain("obsolete");
    expect(doc.toString()).toContain("keep section");
    expect(doc.toString()).toContain("keep setting");
    expect(doc.toJS()).toEqual({ benchmark: { enabled: true } });
  });

  it.each(["other: true\n", "benchmark: null\n", "benchmark: false\n", "benchmark: []\n", "benchmark: {enabled: true}\n"])("does nothing without a mapped obsolete key: %s", (text) => {
    const doc = parseDocument(text);
    const before = doc.toString();
    salary002.migrate(doc);
    expect(doc.toString()).toBe(before);
  });

  it("describes the removed key and reason to manual upgrades", () => {
    expect(salary002.description).toBe("removes benchmark.include_ai_lookups (AI salary lookups never count in the salary benchmark)");
  });
});
