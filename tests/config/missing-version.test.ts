// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError, currentConfigVersion, legacyFormatVersion, reloadConfig, resetConfigCache } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const user = (): string => path.join(temp.configDir, "ui.yaml");

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => {
  vi.restoreAllMocks();
  temp.cleanup();
});

describe("a user file without config_version", () => {
  it("is read as a whole file (the shipped file is not read for its value), and said once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shipped = fs.readFileSync(path.join(temp.defaultsDir, "ui.yaml"), "utf8").replace(/^config_version: \d+\n/m, "").replace(/^trend_cycles: \d+/m, "trend_cycles: 3");
    fs.writeFileSync(user(), shipped);
    resetConfigCache();
    expect(reloadConfig("ui").trend_cycles).toBe(3);
    reloadConfig("ui");
    const shown = warn.mock.calls.filter((call) => String(call[0]).includes("has no config_version"));
    expect(shown).toHaveLength(1);
    expect(String(shown[0]?.[0])).not.toContain("trend_cycles");
  });
});

describe("!unset", () => {
  it("in an older file is an error that says what to add", () => {
    fs.writeFileSync(user(), `config_version: ${legacyFormatVersion("ui")}\ntrend_cycles: !unset\n`);
    expect(() => reloadConfig("ui")).toThrowError(new RegExp(`config_version: ${currentConfigVersion("ui")}`));
    expect(() => reloadConfig("ui")).toThrow(ConfigError);
  });

  it("at the overlay version removes the key: the schema's default answers, or says the key is required", () => {
    fs.writeFileSync(path.join(temp.configDir, "schedule.yaml"), `config_version: ${currentConfigVersion("schedule")}\nbackup:\n  max_age_hours: !unset\n`);
    expect(reloadConfig("schedule").backup.max_age_hours).toEqual(expect.any(Number));
    fs.writeFileSync(user(), `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: !unset\n`);
    expect(() => reloadConfig("ui")).toThrow(/trend_cycles/);
  });
});
