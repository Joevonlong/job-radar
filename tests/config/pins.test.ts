// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, loadConfig, reloadConfig, writeConfig } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const user = (): string => path.join(temp.configDir, "ui.yaml");
const shipped = (): string => path.join(temp.defaultsDir, "ui.yaml");
const overlay = (): Record<string, unknown> => parseConfigYaml(fs.readFileSync(user(), "utf8"), { unset: "overlay" }) as Record<string, unknown>;
const version = (): number => currentConfigVersion("ui");

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("a form save writes only what differs", () => {
  it("a new file holds the version and the changed key, nothing else", async () => {
    const current = loadConfig("ui");
    await writeConfig("ui", { ...current, trend_cycles: current.trend_cycles + 5 });
    expect(overlay()).toEqual({ config_version: version(), trend_cycles: current.trend_cycles + 5 });
    expect(fs.readFileSync(user(), "utf8")).toMatch(/^# Your changes to the shipped ui\.yaml/);
    expect(reloadConfig("ui").trend_cycles).toBe(current.trend_cycles + 5);
  });

  it("a pinned key stays pinned when saved unchanged, and a changed value goes back out when it equals the shipped one", async () => {
    const current = loadConfig("ui");
    fs.writeFileSync(user(), `# my note\nconfig_version: ${version()}\ntrend_cycles: ${current.trend_cycles} # pinned on purpose\n`);
    const pinned = reloadConfig("ui");
    await writeConfig("ui", { ...pinned });
    const text = fs.readFileSync(user(), "utf8");
    expect(text).toContain("# my note");
    expect(text).toContain("# pinned on purpose");
    expect(overlay().trend_cycles).toBe(current.trend_cycles);
  });

  it("nothing to change: the file stays byte for byte", async () => {
    const text = `config_version: ${version()}\n# my own layout\ntrend_cycles:     9\n`;
    fs.writeFileSync(user(), text);
    await writeConfig("ui", reloadConfig("ui"));
    expect(fs.readFileSync(user(), "utf8")).toBe(text);
  });

  it("a key the user file does not hold keeps following the shipped file after a save", async () => {
    const current = loadConfig("ui");
    await writeConfig("ui", { ...current, trend_cycles: current.trend_cycles + 5 });
    fs.writeFileSync(shipped(), fs.readFileSync(shipped(), "utf8").replace(/^(\s*backups_keep:\s*)\d+/m, "$1123"));
    expect(reloadConfig("ui").config_editor.backups_keep).toBe(123);
    expect(reloadConfig("ui").trend_cycles).toBe(current.trend_cycles + 5);
  });
});
