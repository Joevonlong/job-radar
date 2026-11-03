// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { mergeLayers } from "@/lib/config/merge";
import { applyOverlayEdits } from "@/lib/config/overlay-diff";
import { overlaySaveEdits } from "@/lib/config/overlay";
import { replaceRule } from "@/lib/config/overlay-rules";
import { loadConfig, reloadConfig, writeConfig } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";

/** Values only the schema fills in are not written: a later change of a default must still reach the user. */
let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("a save does not pin schema defaults", () => {
  it("no key the user did not change lands in the file", async () => {
    const value = loadConfig("schedule");
    await writeConfig("schedule", { ...value, timezone: value.timezone === "UTC" ? "Europe/Berlin" : "UTC" });
    const saved = parseConfigYaml(fs.readFileSync(path.join(temp.configDir, "schedule.yaml"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["config_version", "timezone"]);
  });

  it("a key the shipped file lacks, filled by the schema, is not written either", () => {
    const schema = configRegistry.ui.schema;
    const shippedRaw = parseConfigYaml(fs.readFileSync(path.join(temp.defaultsDir, "ui.yaml"), "utf8")) as Record<string, unknown>;
    delete shippedRaw.config_version;
    const value = schema.parse(shippedRaw) as Record<string, unknown>;
    const edits = overlaySaveEdits("ui", { shipped: shippedRaw, overlay: {}, value: { ...value, trend_cycles: 40 } });
    expect(edits).toEqual([{ op: "set", path: ["trend_cycles"], value: 40 }]);
    const merged = mergeLayers(shippedRaw, applyOverlayEdits({}, edits), { replaceAt: replaceRule("ui") });
    expect(schema.parse(merged)).toEqual({ ...value, trend_cycles: 40 });
  });

  it("a later change of a shipped default reaches the user after a save", async () => {
    const value = loadConfig("schedule");
    await writeConfig("schedule", { ...value, timezone: value.timezone === "UTC" ? "Europe/Berlin" : "UTC" });
    const shipped = path.join(temp.defaultsDir, "schedule.yaml");
    fs.writeFileSync(shipped, fs.readFileSync(shipped, "utf8").replace(/^(\s*keep_daily:\s*)\d+/m, "$1321"));
    expect(reloadConfig("schedule").backup.keep_daily).toBe(321);
  });
});
