// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, ensureConfigFiles, hasOverlayFormat, legacyFormatVersion, loadConfig, newFileFormat, parseConfigText, reloadConfig, resetConfigCache, writeConfig, LAYERED_CONFIG_NAMES } from "@/lib/config";
import { configRegistry } from "@/lib/config/registry";
import { saveAdvanced } from "@/lib/settings/advanced/service";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

/**
 * The production order: conversion, form saves on overlays, `--to-full`, older code reads the whole files (it only knows
 * the older version), and an upgrade again. Runs against the real CLI; the lock is the stand-in, the real one has its own
 * integration tests.
 */
let temp: TempConfig;
const file = (name: string): string => path.join(temp.configDir, name);
const parsed = (name: string): Record<string, unknown> => parseConfigYaml(fs.readFileSync(file(name), "utf8"), { unset: "overlay" }) as Record<string, unknown>;

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

async function pinned(): Promise<number> {
  const value = loadConfig("ui");
  const trend = value.trend_cycles + 3;
  await writeConfig("ui", { ...value, trend_cycles: trend });
  expect(parsed("ui.yaml").config_version).toBe(currentConfigVersion("ui"));
  return trend;
}

describe("--to-full", () => {
  it("the preview changes nothing; --write gives whole files at the older version with the same value, originals archived", async () => {
    const trend = await pinned();
    const overlay = fs.readFileSync(file("ui.yaml"), "utf8");
    const value = reloadConfig("ui");
    const preview = runConfigScript(temp, "config-migrate.ts", ["--to-full"]);
    expect(preview.status, preview.out).toBe(0);
    expect(fs.readFileSync(file("ui.yaml"), "utf8")).toBe(overlay);
    const r = runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]);
    expect(r.status, r.out).toBe(0);
    const whole = parsed("ui.yaml");
    expect(whole.config_version).toBe(legacyFormatVersion("ui"));
    expect(whole.trend_cycles).toBe(trend);
    expect(Object.keys(whole).length).toBeGreaterThan(2);
    resetConfigCache();
    expect(reloadConfig("ui")).toEqual(value);
    const backups = fs.readdirSync(path.join(temp.configDir, ".backup"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(temp.configDir, ".backup", backups[0] as string, "ui.yaml"), "utf8")).toBe(overlay);
  });

  it("after it, form saves and new files stay whole at the older version", async () => {
    await pinned();
    expect(runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]).status).toBe(0);
    resetConfigCache();
    expect(newFileFormat()).toBe("legacy");
    const ui = reloadConfig("ui");
    await writeConfig("ui", { ...ui, trend_cycles: ui.trend_cycles + 1 });
    expect(parsed("ui.yaml").config_version).toBe(legacyFormatVersion("ui"));
    const search = reloadConfig("search");
    await writeConfig("search", { ...search });
    expect(parsed("search.yaml").config_version).toBe(legacyFormatVersion("search"));
  });

  /** What the code before the overlay format needs of the directory: every file at its whole-file version, readable on its own. */
  function olderCodeAccepts(): void {
    for (const name of LAYERED_CONFIG_NAMES) {
      const target = file(configRegistry[name].file);
      if (!hasOverlayFormat(name) || !fs.existsSync(target)) continue;
      const text = fs.readFileSync(target, "utf8");
      expect((parseConfigYaml(text, { unset: "overlay" }) as Record<string, unknown>).config_version, name).toBe(legacyFormatVersion(name));
      expect(text, name).not.toContain("!unset");
      expect(() => parseConfigText(name, text), name).not.toThrow();
    }
  }

  it("after it, the form, the editor and a new file all write whole files, and the older code accepts every file", async () => {
    await pinned();
    expect(runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]).status).toBe(0);
    resetConfigCache();
    olderCodeAccepts();

    // the form
    const ui = reloadConfig("ui");
    await writeConfig("ui", { ...ui, trend_cycles: ui.trend_cycles + 1 });
    // the editor, on a file that has no user copy yet and on one that has
    const open = (stem: string) => {
      const loaded = loadAdvancedFile(stem);
      if (!loaded.ok) throw new Error("not loadable");
      return loaded.data;
    };
    const fresh = open("search");
    expect(await saveAdvanced({ file: "search", text: fresh.text, baseHash: fresh.hash, baseLayer: fresh.layer, confirmOverride: false })).toMatchObject({ status: "saved" });
    const existing = open("ui");
    const edited = existing.text.replace(/^trend_cycles: \d+/m, `trend_cycles: ${ui.trend_cycles + 2}`);
    expect(edited).not.toBe(existing.text);
    expect(await saveAdvanced({ file: "ui", text: edited, baseHash: existing.hash, baseLayer: existing.layer, confirmOverride: false })).toMatchObject({ status: "saved" });
    // new files from config:init
    const created = (await ensureConfigFiles()).filter((r) => r.created && hasOverlayFormat(r.name));
    expect(created.length).toBeGreaterThan(2);

    resetConfigCache();
    expect(reloadConfig("ui").trend_cycles).toBe(ui.trend_cycles + 2);
    olderCodeAccepts();
  });

  it("upgrade, pin, downgrade, upgrade again: a pin equal to the shipped value is lost, a changed one survives", async () => {
    const shippedTrend = loadConfig("ui").trend_cycles;
    const backups = loadConfig("ui").config_editor.backups_keep + 4;
    fs.writeFileSync(file("ui.yaml"), `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: ${shippedTrend}\nconfig_editor:\n  backups_keep: ${backups}\n`);
    resetConfigCache();
    expect(runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]).status).toBe(0);
    expect(runConfigScript(temp, "config-migrate.ts", ["--write", "--convert-overlays"]).status).toBe(0);
    resetConfigCache();
    const overlay = parsed("ui.yaml");
    expect(overlay.config_version).toBe(currentConfigVersion("ui"));
    expect(overlay).not.toHaveProperty("trend_cycles");
    expect(overlay.config_editor).toEqual({ backups_keep: backups });
    expect(loadConfig("ui").trend_cycles).toBe(shippedTrend);
  });

  it("upgrade, pin, downgrade, upgrade again: the pinned value survives, the rest follows the shipped file", async () => {
    const trend = await pinned();
    expect(runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]).status).toBe(0);
    expect(runConfigScript(temp, "config-migrate.ts", ["--write", "--convert-overlays"]).status).toBe(0);
    resetConfigCache();
    const overlay = parsed("ui.yaml");
    expect(overlay.config_version).toBe(currentConfigVersion("ui"));
    expect(overlay.trend_cycles).toBe(trend);
    expect(Object.keys(overlay).sort()).toEqual(["config_version", "trend_cycles"]);
  });

  it("with no overlay there is nothing to do", () => {
    const r = runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("no overlay");
  });
});

describe("--restore", () => {
  it("refuses without --accept-loss and a bad time; with it the backup comes back and what stood there is archived", async () => {
    await pinned();
    const converted = fs.readFileSync(file("ui.yaml"), "utf8");
    expect(runConfigScript(temp, "config-migrate.ts", ["--to-full", "--write"]).status).toBe(0);
    const time = fs.readdirSync(path.join(temp.configDir, ".backup"))[0] as string;
    const whole = fs.readFileSync(file("ui.yaml"), "utf8");

    const refused = runConfigScript(temp, "config-migrate.ts", ["--restore", time]);
    expect(refused.status).toBe(2);
    expect(refused.out).toContain("--accept-loss");
    expect(fs.readFileSync(file("ui.yaml"), "utf8")).toBe(whole);
    expect(runConfigScript(temp, "config-migrate.ts", ["--restore", "../../etc", "--accept-loss"]).status).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1100)); // backups are named by the second
    const r = runConfigScript(temp, "config-migrate.ts", ["--restore", time, "--accept-loss"]);
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(file("ui.yaml"), "utf8")).toBe(converted);
    expect(fs.readdirSync(path.join(temp.configDir, ".backup"))).toHaveLength(2);
  });
});
