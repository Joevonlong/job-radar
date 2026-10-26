// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, getAppRoot, getConfigDir, getDefaultsDir, getProfileDir, getProfileExampleDir, loadConfig, parseConfigText, reloadConfig, resetConfigCache } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

function catchError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("returns a typed value and caches it", () => {
    const a = loadConfig("schedule");
    expect(a.timezone).toBe("Europe/Berlin");
    expect(a.cycles.weekend.cron).toBe("0 9 * * 0,6");
    expect(loadConfig("schedule")).toBe(a);
  });

  it("returns deeply frozen values", () => {
    const search = loadConfig("search");
    expect(() => {
      search.locations.push("Hamburg");
    }).toThrow();
  });

  it("serves the cache until reloadConfig, and keeps the old value when the reload fails", () => {
    const file = path.join(tmp.configDir, "notify.yaml");
    const first = loadConfig("notify");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("push_min_score: 70", "push_min_score: 55"));
    expect(loadConfig("notify").push_min_score).toBe(first.push_min_score);
    expect(reloadConfig("notify").push_min_score).toBe(55);

    fs.writeFileSync(file, "push_min_score: nope\n");
    expect(() => reloadConfig("notify")).toThrow(ConfigError);
    expect(loadConfig("notify").push_min_score).toBe(55);
  });

  it("does not mix up caches when the directory changes", () => {
    const other = makeTempConfig();
    try {
      fs.writeFileSync(path.join(other.configDir, "ai.yaml"), fs.readFileSync(path.join(other.configDir, "ai.yaml"), "utf8").replace("per_cycle_limit: 80", "per_cycle_limit: 5"));
      expect(loadConfig("ai").per_cycle_limit).toBe(5);
    } finally {
      other.cleanup();
    }
    const again = makeTempConfig();
    try {
      expect(loadConfig("ai").per_cycle_limit).toBe(80);
    } finally {
      again.cleanup();
    }
  });
});

describe("directories", () => {
  it("resolves relative env values against the app root, not cwd", () => {
    process.env.JOB_RADAR_CONFIG_DIR = "custom-config";
    const cwd = process.cwd();
    process.chdir(tmp.root);
    try {
      expect(getConfigDir()).toBe(path.resolve(getAppRoot(), "custom-config"));
      expect(JSON.parse(fs.readFileSync(path.join(getAppRoot(), "package.json"), "utf8")).name).toBe("job-radar"); // the folder name is free (a worktree or a clone)
      expect(getConfigDir().startsWith(fs.realpathSync(tmp.root))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("defaults to <app>/config (shipped defaults), <app>/data/config (user) and <app>/data/profile", () => {
    delete process.env.JOB_RADAR_DEFAULTS_DIR;
    delete process.env.JOB_RADAR_CONFIG_DIR;
    delete process.env.JOB_RADAR_PROFILE_DIR;
    expect(getDefaultsDir()).toBe(path.join(getAppRoot(), "config"));
    expect(getConfigDir()).toBe(path.join(getAppRoot(), "data", "config"));
    expect(getProfileDir()).toBe(path.join(getAppRoot(), "data", "profile"));
    expect(getProfileExampleDir()).toBe(path.join(getAppRoot(), "config", "profile.example"));
  });
});

describe("error formatting", () => {
  it("reports file path and field paths for schema errors, without values or file contents", () => {
    const file = path.join(tmp.configDir, "schedule.yaml");
    fs.writeFileSync(
      file,
      [
        "timezone: Europe/Berlin",
        "cycles:",
        "  weekday_morning: { cron: 'SECRET-TOKEN-123', enabled: true }",
        "  weekday_evening: { cron: '0 17 * * 1-5', enabled: true }",
        "  weekend: { cron: '0 9 * * 0,6', enabled: true, oops: 1 }",
        "catch_up: true",
        "skip_if_running: 3",
        "backup: { enabled: true, cron: '30 3 * * *', keep_daily: 14, keep_weekly: 8, timeout_minutes: 30 }",
        "",
      ].join("\n"),
    );
    const err = catchError(() => loadConfig("schedule"));
    expect(err.kind).toBe("schema");
    expect(err.filePath).toBe(file);
    expect(err.configName).toBe("schedule");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["cycles.weekday_morning.cron", "cycles.weekend.oops", "skip_if_running"]);
    expect(err.message).toContain(file);
    expect(err.message).toContain("cycles.weekday_morning.cron");
    expect(err.message).toContain("unknown key");
    expect(err.message).not.toContain("SECRET-TOKEN-123");
    expect(err.message).not.toContain("Europe/Berlin");
  });

  it("reports YAML syntax errors with line number but not the source excerpt", () => {
    const file = path.join(tmp.configDir, "search.yaml");
    fs.writeFileSync(file, "locations: [Berlin\nsecret_marker: abc: def\n");
    const err = catchError(() => loadConfig("search"));
    expect(err.kind).toBe("yaml");
    expect(err.message).toMatch(/line \d+/);
    expect(err.message).not.toContain("secret_marker");
  });

  it("rejects duplicate keys", () => {
    const text = fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8") + "push_min_score: 1\n";
    expect(catchError(() => parseConfigText("notify", text)).kind).toBe("yaml");
  });

  it("reports an empty document at the root", () => {
    fs.writeFileSync(path.join(tmp.configDir, "ai.yaml"), "# nothing\n");
    const err = catchError(() => loadConfig("ai"));
    expect(err.kind).toBe("schema");
    expect(err.message).toContain("ai.yaml");
  });

  it("reports a missing file", () => {
    resetConfigCache();
    fs.rmSync(path.join(tmp.defaultsDir, "profile.example/me.yaml"));
    const err = catchError(() => loadConfig("me"));
    expect(err.kind).toBe("missing");
    expect(err.filePath).toBe(path.join(tmp.profileDir, "me.yaml"));
  });

  it("caps the number of issues in the message", () => {
    const err = catchError(() => parseConfigText("search", "a: 1\n".repeat(1) + Array.from({ length: 40 }, (_, i) => `k${i}: 1`).join("\n")));
    expect(err.issues.length).toBeGreaterThan(20);
    expect(err.message).toMatch(/and \d+ more/);
  });
});
