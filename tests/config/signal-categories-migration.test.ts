// @vitest-environment node
/**
 * interests.yaml 1 -> 2 (tiers become signal categories) and notify.yaml 1 -> 2 (the high-value push threshold),
 * on the commented v1 fixtures: shape, values, comments, idempotence, in-memory loading and `pnpm config:migrate --write`.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { applyConfigMigrations, loadConfig, migrateConfigDocument, parseConfigDocument, planConfigMigrations, validateConfigValue } from "@/lib/config";
import { interests002 } from "@/lib/config/migrations/interests/002-signal-categories";
import { DEFAULT_SIGNAL_CATEGORIES } from "@/lib/signals/defaults";

import { makeTempConfig, type TempConfig } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/config");
const v1Interests = (): string => fs.readFileSync(path.join(FIXTURES, "interests.v1.yaml"), "utf8");
const v1Notify = (): string => fs.readFileSync(path.join(FIXTURES, "notify.v1.yaml"), "utf8");

/** A v1 file with a saved view that uses the old `t12` filter. */
const withT12View = (text: string): string => text.replace("views: []", "views:\n  - id: high-pay\n    name: High pay\n    filters: { t12: true, city: Berlin }");

function migrate(name: "interests" | "notify", text: string): string {
  const doc = parseConfigDocument(name, text, `${name}.yaml`);
  migrateConfigDocument(name, doc, `${name}.yaml`);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

describe("interests.yaml 1 -> 2", () => {
  const after = migrate("interests", withT12View(v1Interests()));
  const value = validateConfigValue("interests", parse(after), "interests.yaml");

  it("turns T1-T4 and the benefit tags into the five default categories, as they always were", () => {
    expect(value.signals.categories.map((c) => [c.id, c.kind])).toEqual([
      ["T1", "amount"],
      ["T2", "keyword"],
      ["T3", "keyword"],
      ["T4", "keyword"],
      ["tag", "tag"],
    ]);
    for (const meta of DEFAULT_SIGNAL_CATEGORIES) {
      const category = value.signals.categories.find((c) => c.id === meta.id);
      expect(category).toMatchObject({ label: meta.label, color: meta.color, high_value: meta.high_value });
      expect(category?.icon).toBe(meta.icon);
      if (meta.kind !== "tag") expect(category?.ai_definition).toBe(meta.ai_definition);
    }
    expect(value.signals.retired_categories).toEqual([]);
  });

  it("moves the weights onto the categories and keeps every word, pattern and amount setting", () => {
    const old = parse(v1Interests()) as { signals: Record<string, Record<string, unknown>> & { benefit_tags: string[]; benefit_patterns: unknown[] }; weights: Record<string, number> };
    expect(value.signals.categories.map((c) => c.weight)).toEqual([old.weights.T1, old.weights.T2, old.weights.T3, old.weights.T4, 0]);
    const [t1, t2, , t4, tag] = value.signals.categories;
    if (t1?.kind !== "amount" || t2?.kind !== "keyword" || t4?.kind !== "keyword" || tag?.kind !== "tag") throw new Error("wrong kinds");
    expect(t1.patterns).toEqual(old.signals.T1?.patterns);
    expect(t1.exclude).toEqual(old.signals.T1?.exclude);
    // the chain goes on to 3: the amount keys say "in the base currency" now, the values are unchanged
    expect(t1.amount).toMatchObject({ min_annual: old.signals.T1?.min_annual_eur, rough_fx: old.signals.T1?.rough_fx_to_eur, bonus_requires_at_least: "salary_floor" });
    expect(t2.keywords).toEqual(old.signals.T2?.keywords);
    expect(t2.default_kind).toBe("equity");
    expect(t4.ai_confirm_only).toBe(true);
    expect(tag.tags).toEqual(old.signals.benefit_tags);
    expect(tag.tag_patterns).toEqual(old.signals.benefit_patterns);
    expect(parse(after)).not.toHaveProperty("weights");
  });

  it("renames per_tier_max and the views' t12, and stamps the version (3 after the market step)", () => {
    expect(value.limits.per_category_max).toBe(3);
    expect(after).not.toContain("per_tier_max");
    expect(value.views[0]?.filters).toEqual({ high: true, city: "Berlin" });
    expect(after).toMatch(/^config_version: 3$/m);
  });

  it("keeps the comments: the file header, the ones above each tier and inside it", () => {
    expect(after.startsWith("# 感兴趣清单")).toBe(true);
    expect(after).toMatch(/# T1：写明具体金额[^\n]*\n[^\n]*\n\s+- id: T1/);
    expect(after).toMatch(/# T2：股权或期权\n\s+- id: T2/);
    expect(after).toMatch(/# 福利标签：[^\n]*\n\s+- id: tag/);
    expect(after).toContain("# 金额没写币种");
    expect(after).toContain("# €85,000–105,000 / EUR 90k");
    expect(after).toContain("# 每个岗位每档最多保留几条信号");
  });

  it("is idempotent: the step changes nothing on a migrated document, and a v2 file has nothing pending", () => {
    const doc = parseDocument(after);
    interests002.migrate(doc);
    expect(doc.toString({ lineWidth: 0, flowCollectionPadding: false })).toBe(after);
  });

  it("keeps a T4 that did not wait for the AI, and gives one without the key the old default", () => {
    const off = validateConfigValue("interests", parse(migrate("interests", v1Interests().replace("    ai_confirm_only: true\n", "    ai_confirm_only: false\n"))), "x");
    expect(off.signals.categories.find((c) => c.id === "T4")?.kind === "keyword" && off.signals.categories.find((c) => c.id === "T4")).toMatchObject({ ai_confirm_only: false });
    const missing = validateConfigValue("interests", parse(migrate("interests", v1Interests().replace("    ai_confirm_only: true\n", ""))), "x");
    expect(missing.signals.categories.find((c) => c.id === "T4")).toMatchObject({ ai_confirm_only: true });
  });
});

describe("notify.yaml 1 -> 2", () => {
  it("renames the high-value threshold and rewords the shipped comment", () => {
    const after = migrate("notify", v1Notify());
    expect(after).toContain("# 带高价值信号（interests.yaml 里 high_value 的信号类别）的岗位门槛更低\npush_min_score_high_value: 60");
    expect(after).not.toContain("t1_t2");
    expect(validateConfigValue("notify", parse(after), "notify.yaml").push_min_score_high_value).toBe(60);
  });

  it("keeps a comment the user wrote", () => {
    const after = migrate("notify", v1Notify().replace("# 带 T1/T2 薪酬信号的岗位门槛更低", "# my own note"));
    expect(after).toContain("# my own note\npush_min_score_high_value: 60");
  });
});

describe("the owner's v1 files after the upgrade", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
    fs.writeFileSync(path.join(tmp.configDir, "interests.yaml"), withT12View(v1Interests()));
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), v1Notify());
  });
  afterEach(() => tmp.cleanup());

  it("are read as v2 in memory without touching the files", () => {
    expect(loadConfig("interests").signals.categories).toHaveLength(5);
    expect(loadConfig("notify").push_min_score_high_value).toBe(60);
    expect(fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8")).toBe(v1Notify());
  });

  it("are written as v2 by config:migrate --write (backed up first), then nothing is pending", async () => {
    const plan = planConfigMigrations();
    expect(plan.problems).toEqual([]);
    expect(plan.pending.map((p) => [p.name, p.from, p.to]).sort()).toEqual([
      ["interests", 1, 3],
      ["notify", 1, 2],
    ]);
    const applied = await applyConfigMigrations(plan, new Date("2026-10-09T08:00:00Z"));
    expect(applied.written).toHaveLength(2);
    expect(fs.readFileSync(path.join(applied.backupDir ?? "", "notify.yaml"), "utf8")).toBe(v1Notify());
    const interests = fs.readFileSync(path.join(tmp.configDir, "interests.yaml"), "utf8");
    expect(interests).toContain("config_version: 3");
    expect(interests).toMatch(/filters: \{ ?high: true, city: Berlin ?\}/);
    expect(planConfigMigrations().pending).toEqual([]);
  });
});
