// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, currentConfigVersion, layeredConfigFingerprint, legacyFormatVersion, readShippedConfig, reloadConfig, writeConfigRepair, type ConfigValue } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const user = (): string => path.join(temp.configDir, "ui.yaml");
const fullValue = (): ConfigValue<"ui"> => readShippedConfig("ui") as ConfigValue<"ui">;

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("writeConfigRepair", () => {
  it("no file yet: a sparse overlay from a complete value", async () => {
    const value = { ...fullValue(), trend_cycles: 41 };
    await writeConfigRepair("ui", value, { previewFingerprint: layeredConfigFingerprint("ui") });
    expect(parseConfigYaml(fs.readFileSync(user(), "utf8"), { unset: "overlay" })).toEqual({ config_version: currentConfigVersion("ui"), trend_cycles: 41 });
    expect(reloadConfig("ui")).toEqual(value);
  });

  it("a broken file: whole (it cannot be told from a whole file), and its text is backed up", async () => {
    fs.writeFileSync(user(), "a: [\n");
    const value = { ...fullValue(), trend_cycles: 41 };
    await writeConfigRepair("ui", value, { previewFingerprint: layeredConfigFingerprint("ui") });
    expect(parseConfigYaml(fs.readFileSync(user(), "utf8"))).toMatchObject({ config_version: legacyFormatVersion("ui"), trend_cycles: 41 });
    expect(reloadConfig("ui")).toEqual(value);
    const backups = fs.readdirSync(temp.configDir, { recursive: true }).map(String).filter((entry) => entry.includes("ui.yaml") && entry !== "ui.yaml");
    expect(backups.length).toBeGreaterThan(0);
  });

  it("writes a whole file while another file still is one", async () => {
    fs.writeFileSync(user(), "a: [\n");
    fs.writeFileSync(path.join(temp.configDir, "search.yaml"), fs.readFileSync(path.join(temp.defaultsDir, "search.yaml"), "utf8").replace(/^config_version: \d+/m, `config_version: ${legacyFormatVersion("search")}`));
    const value = { ...fullValue(), trend_cycles: 41 };
    await writeConfigRepair("ui", value, { previewFingerprint: layeredConfigFingerprint("ui") });
    const saved = parseConfigYaml(fs.readFileSync(user(), "utf8")) as Record<string, unknown>;
    expect(saved.config_version).toBe(legacyFormatVersion("ui"));
    expect(Object.keys(saved).length).toBeGreaterThan(2);
    expect(reloadConfig("ui")).toEqual(value);
  });

  it("refuses when the file changed since the preview, and changes nothing", async () => {
    fs.writeFileSync(user(), "a: [\n");
    const preview = layeredConfigFingerprint("ui");
    fs.writeFileSync(user(), "b: [\n");
    await expect(writeConfigRepair("ui", fullValue(), { previewFingerprint: preview })).rejects.toMatchObject({ kind: "stale" });
    expect(fs.readFileSync(user(), "utf8")).toBe("b: [\n");
  });

  it("refuses a value the schema does not take", async () => {
    fs.writeFileSync(user(), "a: [\n");
    await expect(writeConfigRepair("ui", { ...fullValue(), trend_cycles: "x" } as unknown as ConfigValue<"ui">, { previewFingerprint: layeredConfigFingerprint("ui") })).rejects.toBeInstanceOf(ConfigError);
    expect(fs.readFileSync(user(), "utf8")).toBe("a: [\n");
  });
});
