// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, ensureConfigFiles, hasOverlayFormat, legacyFormatVersion, loadConfig, newFileFormat, overlayFormatVersion, parseConfigText, resetConfigCache, type ConfigName } from "@/lib/config";
import { configRegistry } from "@/lib/config/registry";
import { saveAdvanced } from "@/lib/settings/advanced/service";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const write = (name: string, text: string): void => fs.writeFileSync(path.join(temp.configDir, name), text);

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("newFileFormat", () => {
  it("a new install: overlays", () => {
    expect(newFileFormat()).toBe("overlay");
  });

  it("every file at its overlay version: overlays", () => {
    write("ui.yaml", `config_version: ${overlayFormatVersion("ui")}\n`);
    write("search.yaml", `config_version: ${overlayFormatVersion("search")}\nfoo: !unset\n`);
    expect(newFileFormat()).toBe("overlay");
  });

  it.each([
    ["an older version", () => `config_version: ${legacyFormatVersion("ui")}\n`],
    ["no version", () => "trend_cycles: 3\n"],
    ["a file that does not parse", () => "a: [\n"],
  ])("%s anywhere: whole files", (_label, text) => {
    write("search.yaml", `config_version: ${overlayFormatVersion("search")}\n`);
    write("ui.yaml", text());
    expect(newFileFormat()).toBe("legacy");
  });

  it("models.yaml does not count: it has its own overlay", () => {
    write("models.yaml", "models: []\n");
    expect(newFileFormat()).toBe("overlay");
  });
});

describe("a file created now", () => {
  const userFile = (name: ConfigName): string => path.join(temp.configDir, configRegistry[name].file);
  const versionOf = (name: ConfigName): unknown => (parseConfigYaml(fs.readFileSync(userFile(name), "utf8"), { unset: "overlay" }) as Record<string, unknown>).config_version;
  const wholeNeighbour = (): void => write("ui.yaml", fs.readFileSync(path.join(temp.defaultsDir, "ui.yaml"), "utf8").replace(/^config_version: \d+/m, `config_version: ${legacyFormatVersion("ui")}`));
  const created = (results: Awaited<ReturnType<typeof ensureConfigFiles>>): ConfigName[] => results.filter((r) => r.created && hasOverlayFormat(r.name) && r.name !== "ui").map((r) => r.name);

  it("config:init, with a whole file in the directory: whole files at the whole-file version, which a loader that knows no overlays reads by itself", async () => {
    wholeNeighbour();
    const names = created(await ensureConfigFiles());
    expect(names.length).toBeGreaterThan(2);
    resetConfigCache();
    for (const name of names) {
      expect(versionOf(name), name).toBe(legacyFormatVersion(name));
      // read on its own, without the shipped file under it: the old loader's view
      expect(parseConfigText(name, fs.readFileSync(userFile(name), "utf8")), name).toEqual(loadConfig(name));
    }
  });

  it("config:init with no whole file: overlay stubs at the current version", async () => {
    const names = created(await ensureConfigFiles());
    expect(names.length).toBeGreaterThan(2);
    for (const name of names) {
      expect(versionOf(name), name).toBe(currentConfigVersion(name));
      expect(Object.keys(parseConfigYaml(fs.readFileSync(userFile(name), "utf8"), { unset: "overlay" }) as object), name).toEqual(["config_version"]);
    }
  });

  const open = (stem: string) => {
    const loaded = loadAdvancedFile(stem);
    if (!loaded.ok) throw new Error("not loadable");
    return loaded.data;
  };

  it("the editor, with a whole file in the directory: opens a whole template and saves it as it is, at the whole-file version", async () => {
    wholeNeighbour();
    const data = open("search");
    expect(data.layer).toBe("default");
    expect(Object.keys(parseConfigYaml(data.text, { unset: "overlay" }) as object).length).toBeGreaterThan(2);
    const saved = await saveAdvanced({ file: "search", text: data.text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(saved).toMatchObject({ status: "saved", layer: "user" });
    expect(fs.readFileSync(userFile("search"), "utf8")).toBe(data.text);
    expect(versionOf("search")).toBe(legacyFormatVersion("search"));
    resetConfigCache();
    expect(parseConfigText("search", fs.readFileSync(userFile("search"), "utf8"))).toEqual(loadConfig("search"));
  });

  it("the editor, with no whole file: opens the stub, and saving it unchanged creates the stub and no full copy", async () => {
    const before = loadConfig("search");
    const data = open("search");
    expect(Object.keys(parseConfigYaml(data.text, { unset: "overlay" }) as object)).toEqual(["config_version"]);
    const saved = await saveAdvanced({ file: "search", text: data.text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(saved).toMatchObject({ status: "saved", layer: "user" });
    expect(fs.readFileSync(userFile("search"), "utf8")).toBe(data.text);
    expect(versionOf("search")).toBe(overlayFormatVersion("search"));
    resetConfigCache();
    expect(loadConfig("search")).toEqual(before);
  });
});
