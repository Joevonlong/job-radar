// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyExamplePlan, ConfigExampleError, listExamples, loadConfig, mergeExample, planExample, readExample, resetConfigCache } from "@/lib/config";

import { makeTempConfig, REPO_DEFAULTS_DIR, type TempConfig } from "./helpers";

describe("mergeExample", () => {
  it("merges maps key by key and replaces lists", () => {
    const base = { a: { x: 1, y: [1, 2] }, b: "keep" };
    const replaced: string[] = [];
    expect(mergeExample(base, { a: { y: [3] } }, undefined, "", replaced)).toEqual({ a: { x: 1, y: [3] }, b: "keep" });
    expect(replaced).toEqual(["a.y"]);
  });

  it("adds missing ats_boards and keeps the user's (token compared case-insensitively)", () => {
    const mine = { name: "Mine", ats: "lever", token: "Mine", enabled: false };
    const merged = mergeExample({ ats_boards: [mine] }, { ats_boards: [{ name: "Mine again", ats: "lever", token: "mine", enabled: true }, { name: "New", ats: "ashby", token: "new", enabled: true }] });
    expect(merged).toEqual({ ats_boards: [mine, { name: "New", ats: "ashby", token: "new", enabled: true }] });
  });

  it("replaces keyword_groups while they are the shipped placeholder, else merges them", () => {
    const shipped = { keyword_groups: { targets: ["Placeholder"] } };
    const patch = { keyword_groups: { example: ["Example Role"] } };
    expect(mergeExample(shipped, patch, shipped)).toEqual(patch);
    expect(mergeExample({ keyword_groups: { targets: ["Mine"] } }, patch, shipped)).toEqual({ keyword_groups: { targets: ["Mine"], example: ["Example Role"] } });
    expect(mergeExample(shipped, patch)).toEqual({ keyword_groups: { targets: ["Placeholder"], example: ["Example Role"] } });
  });
});

describe("config examples (pnpm config:example)", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
  });
  afterEach(() => tmp.cleanup());

  const writeExample = (id: string, files: Record<string, string>) => {
    const dir = path.join(tmp.defaultsDir, "examples", id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  };

  it("lists, plans and applies an example into the user directory only, once", async () => {
    writeExample("demo", {
      "example.yaml": "name: Demo\ndescription: A demo setup.\n",
      "search.yaml": "max_per_group_per_location: 7\n",
      "sources.yaml": "ats_boards:\n  - { name: Demo Co, ats: greenhouse, token: democo, enabled: true }\n",
    });
    expect(listExamples().map((e) => [e.id, e.name])).toEqual([["demo", "Demo"]]);
    const shippedSearch = fs.readFileSync(path.join(tmp.defaultsDir, "search.yaml"), "utf8");

    const plan = planExample(readExample("demo"));
    expect(plan.map((c) => [c.name, c.changed])).toEqual([
      ["search", ["max_per_group_per_location"]],
      ["channels", ["ats_boards"]],
    ]);
    const applied = await applyExamplePlan(plan);
    expect(applied.backupDir).toBeNull();
    expect(applied.written).toEqual([path.join(tmp.configDir, "search.yaml"), path.join(tmp.configDir, "sources.yaml")]);
    expect(fs.readFileSync(path.join(tmp.defaultsDir, "search.yaml"), "utf8")).toBe(shippedSearch);

    resetConfigCache();
    expect(loadConfig("search").max_per_group_per_location).toBe(7);
    expect(loadConfig("channels").ats_boards.at(-1)).toMatchObject({ name: "Demo Co", token: "democo" });
    expect(planExample(readExample("demo")).every((c) => c.changed.length === 0)).toBe(true);
  });

  it("backs up the user's files it changes", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "search.yaml"), path.join(tmp.configDir, "search.yaml"));
    writeExample("demo", { "example.yaml": "name: Demo\ndescription: A demo setup.\n", "search.yaml": "max_per_group_per_location: 7\n" });
    const applied = await applyExamplePlan(planExample(readExample("demo")), new Date("2026-10-09T10:00:00Z"));
    expect(applied.backupDir).not.toBeNull();
    expect(fs.existsSync(path.join(applied.backupDir ?? "", "search.yaml"))).toBe(true);
  });

  it("refuses unknown ids, files that are not user config files, and values that fail the schema", () => {
    expect(() => readExample("nope")).toThrow(ConfigExampleError);
    expect(() => readExample("../x")).toThrow(ConfigExampleError);
    writeExample("bad-file", { "example.yaml": "name: Bad\ndescription: Bad.\n", "models.yaml": "providers: {}\n" });
    expect(() => readExample("bad-file")).toThrow(/can only contain/);
    writeExample("bad-value", { "example.yaml": "name: Bad\ndescription: Bad.\n", "search.yaml": "max_per_group_per_location: -1\n" });
    expect(() => planExample(readExample("bad-value"))).toThrow(/max_per_group_per_location/);
  });

  it("every example shipped in the repository applies cleanly to the repository's defaults", async () => {
    fs.rmSync(tmp.defaultsDir, { recursive: true });
    fs.cpSync(REPO_DEFAULTS_DIR, tmp.defaultsDir, { recursive: true });
    const examples = listExamples();
    expect(examples.length).toBeGreaterThan(0);
    for (const info of examples) {
      fs.rmSync(tmp.configDir, { recursive: true, force: true });
      resetConfigCache();
      const plan = planExample(readExample(info.id));
      expect(plan.some((c) => c.changed.length > 0), info.id).toBe(true);
      await applyExamplePlan(plan);
      resetConfigCache();
      expect(planExample(readExample(info.id)).every((c) => c.changed.length === 0), info.id).toBe(true);
    }
  });
});
