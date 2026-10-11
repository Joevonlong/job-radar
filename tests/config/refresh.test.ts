// @vitest-environment node
/** The cached configs follow their files when a long-running process starts a unit of work. */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { freshenConfig, loadConfig, refreshConfigCache } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

/** A migration step that throws (a bug, not a ConfigError) for preferences.yaml while `brokenMigration.on` is set. */
const brokenMigration = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/config/migrations/version", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config/migrations/version")>();
  return {
    ...original,
    migrateConfigDocument: (...args: Parameters<typeof original.migrateConfigDocument>) => {
      if (brokenMigration.on && args[0] === "preferences") throw new TypeError("migration step bug");
      return original.migrateConfigDocument(...args);
    },
  };
});

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

/** What another process (the web) does: write the file, leaving this process's cache alone. */
function writeElsewhere(file: string, edit: (text: string) => string): void {
  fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
}

describe("refreshConfigCache", () => {
  it("does nothing while the files are unchanged", () => {
    loadConfig("schedule");
    expect(refreshConfigCache()).toEqual({ changed: [], errors: [] });
  });

  it("replaces a cached value whose file another process changed", () => {
    const before = loadConfig("search");
    const file = path.join(tmp.configDir, "search.yaml");
    writeElsewhere(file, (text) => `${text}\n# edited\n`);
    // loadConfig alone keeps serving the cache: that is what left the runner on the old values
    expect(loadConfig("search")).toBe(before);
    expect(refreshConfigCache().changed).toEqual(["search"]);
    expect(loadConfig("search")).not.toBe(before);
    expect(loadConfig("search")).toEqual(before);
  });

  it("covers the profile files (the market lives in preferences.yaml)", () => {
    fs.mkdirSync(tmp.profileDir, { recursive: true });
    const file = path.join(tmp.profileDir, "preferences.yaml");
    fs.copyFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), file);
    expect(loadConfig("preferences").salary_floor_year).toBe(70000);
    writeElsewhere(file, (text) => text.replace("salary_floor_year: 70000", "salary_floor_year: 90000"));
    expect(refreshConfigCache().changed).toEqual(["preferences"]);
    expect(loadConfig("preferences").salary_floor_year).toBe(90000);
  });

  it("keeps the last good value of a broken file and reports it", () => {
    const before = loadConfig("schedule");
    fs.writeFileSync(path.join(tmp.configDir, "schedule.yaml"), "timezone: [unclosed\n");
    const result = refreshConfigCache();
    expect(result.changed).toEqual([]);
    expect(result.errors.map((e) => e.configName)).toEqual(["schedule"]);
    expect(loadConfig("schedule")).toBe(before);
  });

  it("never throws: an unexpected error (a migration bug) keeps the last good value and is reported as a read error", () => {
    fs.mkdirSync(tmp.profileDir, { recursive: true });
    const file = path.join(tmp.profileDir, "preferences.yaml");
    fs.copyFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), file);
    const before = loadConfig("preferences");
    writeElsewhere(file, (text) => text.replace("salary_floor_year: 70000", "salary_floor_year: 90000"));
    brokenMigration.on = true;
    try {
      const result = refreshConfigCache();
      expect(result.changed).toEqual([]);
      expect(result.errors.map((e) => [e.configName, e.kind])).toEqual([["preferences", "read"]]);
      expect(result.errors[0]?.message).toContain("migration step bug");
      expect(loadConfig("preferences")).toBe(before);
    } finally {
      brokenMigration.on = false;
    }
    expect(refreshConfigCache().changed).toEqual(["preferences"]);
  });

  it("leaves configs that were never loaded to be read on first use", () => {
    writeElsewhere(path.join(tmp.configDir, "ui.yaml"), (text) => `${text}\n# edited\n`);
    expect(refreshConfigCache().changed).toEqual([]);
  });

  it("freshenConfig logs what changed and never throws for a bad file", () => {
    loadConfig("schedule");
    loadConfig("search");
    writeElsewhere(path.join(tmp.configDir, "search.yaml"), (text) => `${text}\n# edited\n`);
    fs.writeFileSync(path.join(tmp.configDir, "schedule.yaml"), "timezone: [unclosed\n");
    const lines: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const logger = { info: (m: string, f?: Record<string, unknown>) => void lines.push(["info", m, f]), warn: (m: string, f?: Record<string, unknown>) => void lines.push(["warn", m, f]) };
    expect(freshenConfig(logger)).toEqual(["search"]);
    expect(lines.map(([level, , fields]) => [level, fields?.configs ?? fields?.config])).toEqual([
      ["info", ["search"]],
      ["warn", "schedule"],
    ]);
  });
});
