// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, legacyFormatVersion, reloadConfig, resetConfigCache } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

let temp: TempConfig;
const user = (): string => path.join(temp.configDir, "notify.yaml");
const read = (): Record<string, unknown> => parseConfigYaml(fs.readFileSync(user(), "utf8"), { unset: "overlay" }) as Record<string, unknown>;

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
  fs.copyFileSync(path.resolve(import.meta.dirname, "../fixtures/config/notify.v1.yaml"), user());
  resetConfigCache();
});
afterEach(() => temp.cleanup());

describe("config:migrate", () => {
  it("--write without the flag stops at the last whole-file version", () => {
    const r = runConfigScript(temp, "config-migrate.ts", ["--write"]);
    expect(r.status, r.out).toBe(0);
    expect(read().config_version).toBe(legacyFormatVersion("notify"));
    expect(Object.keys(read()).length).toBeGreaterThan(1);
  });

  it("the preview of a conversion lists keys and changes nothing", () => {
    const before = fs.readFileSync(user(), "utf8");
    const r = runConfigScript(temp, "config-migrate.ts", ["--convert-overlays"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("--write --convert-overlays");
    expect(fs.readFileSync(user(), "utf8")).toBe(before);
    expect(fs.readdirSync(temp.configDir).filter((file) => file.startsWith("conversion-"))).toEqual([]);
  });

  it("--write --convert-overlays gives the same value as an overlay, with a record of keys and a backup", () => {
    resetConfigCache();
    const value = reloadConfig("notify");
    const r = runConfigScript(temp, "config-migrate.ts", ["--write", "--convert-overlays"]);
    expect(r.status, r.out).toBe(0);
    expect(read().config_version).toBe(currentConfigVersion("notify"));
    resetConfigCache();
    expect(reloadConfig("notify")).toEqual(value);
    const records = fs.readdirSync(temp.configDir).filter((file) => /^conversion-.*\.json$/.test(file));
    expect(records).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(temp.configDir, records[0] as string), "utf8")) as { files: Record<string, { dropped: string[]; kept: string[] }> };
    expect(Object.keys(record.files)).toEqual(["notify.yaml"]);
    expect(fs.readdirSync(path.join(temp.configDir, ".backup"))).toHaveLength(1);
    const again = runConfigScript(temp, "config-migrate.ts", ["--write", "--convert-overlays"]);
    expect(again.out).toContain("nothing to migrate");
  });
});
