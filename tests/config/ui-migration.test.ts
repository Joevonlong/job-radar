// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { applyConfigMigrations, loadConfig, parseConfigText, planConfigMigrations, readConfigText, validateConfigText } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
/** The user's ui.yaml as it was before the config editor: no version, none of the three new blocks. */
function writeVersion1Ui(): string {
  const file = path.join(tmp.configDir, "ui.yaml");
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  for (const key of ["config_version", "applications", "filters", "config_editor"]) doc.delete(key);
  const text = doc.toString();
  fs.writeFileSync(file, text);
  return text;
}

beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

describe("ui.yaml 1 -> 2", () => {
  it("an old file runs in memory with the new blocks' defaults", () => {
    writeVersion1Ui();
    const ui = loadConfig("ui");
    expect(ui.applications.hidden_statuses).toEqual([]);
    expect(ui.filters).toMatchObject({ hidden_workplaces: [], hidden_contracts: [] });
    expect(ui.filters.company_options_max).toBeGreaterThan(0);
    expect(ui.filters.company_options_visible).toBeGreaterThan(0);
    expect(ui.config_editor.backups_keep).toBeGreaterThan(0);
  });

  it("--write inserts the three blocks with comments, keeps the rest, and is idempotent", async () => {
    const file = path.join(tmp.configDir, "ui.yaml");
    const before = writeVersion1Ui();
    const plan = planConfigMigrations(["ui"]);
    expect(plan.pending).toHaveLength(1);
    await applyConfigMigrations(plan);
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("config_version: 2");
    for (const key of ["applications:", "filters:", "config_editor:", "hidden_statuses: []"]) expect(after).toContain(key);
    for (const line of before.split("\n").filter((l) => l.trim().startsWith("#"))) expect(after).toContain(line.trim());
    expect(parseDocument(after).errors).toHaveLength(0);
    expect(validateConfigText("ui", after).ok).toBe(true);
    expect(planConfigMigrations(["ui"]).pending).toHaveLength(0);
  });

  it("does not touch blocks the file already has", async () => {
    const file = path.join(tmp.configDir, "ui.yaml");
    fs.writeFileSync(file, `${writeVersion1Ui()}\napplications:\n  hidden_statuses: [preparing]\n`);
    await applyConfigMigrations(planConfigMigrations(["ui"]));
    expect(parseConfigText("ui", readConfigText("ui")).applications.hidden_statuses).toEqual(["preparing"]);
  });

  it("rejects hiding new / archived and duplicates", () => {
    const body = (list: string) => `salary_axis: {min_k: 40, max_k: 200, tick_step_k: 20}\nfreshness: {decay_hours: 72, warn_hours: 24}\ntrend_cycles: 7\nhealth_cycles: 14\nticker_max_items: 8\napplications:\n  hidden_statuses: ${list}\n`;
    expect(() => parseConfigText("ui", `config_version: 2\n${body("[new]")}`)).toThrow();
    expect(() => parseConfigText("ui", `config_version: 2\n${body("[archived]")}`)).toThrow();
    expect(() => parseConfigText("ui", `config_version: 2\n${body("[applied, applied]")}`)).toThrow();
    expect(parseConfigText("ui", `config_version: 2\n${body("[applied]")}`).applications.hidden_statuses).toEqual(["applied"]);
  });
});
