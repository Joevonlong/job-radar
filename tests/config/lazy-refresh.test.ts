// @vitest-environment node
/**
 * A process without a config watcher (the web, the MCP server) follows changes other processes make to the config files:
 * `loadConfig` brings the cache in line with the files, at most once per `JOB_RADAR_CONFIG_POLL_MS`.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, refreshConfigCache, reloadConfig, watchConfig, writeConfig } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

const INTERVAL_MS = 1000;

let tmp: TempConfig;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  tmp = makeTempConfig();
  process.env.JOB_RADAR_CONFIG_POLL_MS = String(INTERVAL_MS);
  // only the clock: real timers and real files stay as they are
  vi.useFakeTimers({ toFake: ["Date"] });
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  tmp.cleanup();
});

const uiFile = () => path.join(tmp.configDir, "ui.yaml");
const prefsFile = () => path.join(tmp.profileDir, "preferences.yaml");

function edit(file: string, from: string, to: string): void {
  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
}

function copyPreferences(): void {
  fs.mkdirSync(tmp.profileDir, { recursive: true });
  fs.copyFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), prefsFile());
}

/** How many config files the code reads from disk while `fn` runs. */
function countReads(fn: () => void): number {
  const spy = vi.spyOn(fs, "readFileSync");
  try {
    fn();
    return spy.mock.calls.filter(([file]) => String(file).startsWith(tmp.root)).length;
  } finally {
    spy.mockRestore();
  }
}

describe("loadConfig without a watcher", () => {
  it("serves the cache and reads nothing from disk within the interval", () => {
    const first = loadConfig("ui");
    edit(uiFile(), "trend_cycles: 7", "trend_cycles: 9");
    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(countReads(() => loadConfig("ui"))).toBe(0);
    expect(loadConfig("ui")).toBe(first);
    expect(loadConfig("ui").trend_cycles).toBe(7);
  });

  it("gives the changed value to the first call after the interval, then the cache again", () => {
    loadConfig("ui");
    edit(uiFile(), "trend_cycles: 7", "trend_cycles: 9");
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").trend_cycles).toBe(9);
    edit(uiFile(), "trend_cycles: 9", "trend_cycles: 11");
    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(loadConfig("ui").trend_cycles).toBe(9);
    vi.advanceTimersByTime(1);
    expect(loadConfig("ui").trend_cycles).toBe(11);
  });

  it("reads each cached config once per refresh, and nothing for an unchanged cache in between", () => {
    loadConfig("ui");
    loadConfig("search");
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(countReads(() => loadConfig("ui"))).toBe(2);
    expect(countReads(() => loadConfig("search"))).toBe(0);
  });

  it("does not refresh when the interval is 0", () => {
    process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
    loadConfig("ui");
    edit(uiFile(), "trend_cycles: 7", "trend_cycles: 9");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(loadConfig("ui").trend_cycles).toBe(7);
  });

  it("does not refresh while a watcher runs, and does again after it stopped", () => {
    loadConfig("ui");
    const stop = watchConfig(["ui"], () => undefined, { pollMs: 0, fsWatch: false });
    edit(uiFile(), "trend_cycles: 7", "trend_cycles: 9");
    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(loadConfig("ui").trend_cycles).toBe(7);
    stop();
    stop();
    expect(loadConfig("ui").trend_cycles).toBe(9);
  });

  it("replaces a config as a whole: two changed keys arrive together in one new object", () => {
    copyPreferences();
    const before = loadConfig("preferences");
    edit(prefsFile(), "salary_floor_year: 70000", "salary_floor_year: 90000");
    const text = fs.readFileSync(prefsFile(), "utf8");
    fs.writeFileSync(prefsFile(), `${text}\n# another edit\n`);
    vi.advanceTimersByTime(INTERVAL_MS);
    const after = loadConfig("preferences");
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...before, salary_floor_year: 90000 });
  });

  it("refreshes the profile files, me.yaml included", () => {
    fs.mkdirSync(tmp.profileDir, { recursive: true });
    const me = path.join(tmp.profileDir, "me.yaml");
    fs.copyFileSync(path.join(tmp.defaultsDir, "profile.example", "me.yaml"), me);
    expect(loadConfig("me").needs_visa_sponsorship).toBe(false);
    edit(me, "needs_visa_sponsorship: false", "needs_visa_sponsorship: true");
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("me").needs_visa_sponsorship).toBe(true);
  });

  it("falls back to the shipped value when the user's copy is deleted", () => {
    edit(uiFile(), "trend_cycles: 7", "trend_cycles: 9");
    expect(loadConfig("ui").trend_cycles).toBe(9);
    fs.rmSync(uiFile());
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").trend_cycles).toBe(7);
  });

  describe("a bad file", () => {
    it("keeps the last valid value, reports a given bad content once, and recovers when fixed", () => {
      const good = loadConfig("ui");
      const goodText = fs.readFileSync(uiFile(), "utf8");
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("ui");

      // the same content on later refreshes: still the old value, no new report
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(INTERVAL_MS);
        expect(loadConfig("ui")).toBe(good);
      }
      expect(errors).toHaveBeenCalledTimes(1);

      // other bad content (here: parses, fails validation) is reported again
      fs.writeFileSync(uiFile(), goodText.replace("trend_cycles: 7", "trend_cycles: nope"));
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(2);

      // fixed: the new value is in effect
      fs.writeFileSync(uiFile(), goodText.replace("trend_cycles: 7", "trend_cycles: 12"));
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui").trend_cycles).toBe(12);
      expect(errors).toHaveBeenCalledTimes(2);

      // and the same bad content after a good one counts as a new problem
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui").trend_cycles).toBe(12);
      expect(errors).toHaveBeenCalledTimes(3);
    });

    it("reports the bad content again after it was restored to what the cache holds and broken once more", () => {
      loadConfig("ui");
      const goodText = fs.readFileSync(uiFile(), "utf8");
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      loadConfig("ui");
      fs.writeFileSync(uiFile(), goodText);
      vi.advanceTimersByTime(INTERVAL_MS);
      loadConfig("ui");
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      loadConfig("ui");
      expect(errors).toHaveBeenCalledTimes(2);
    });

    it("reports the same bad content again after a good value arrived through reloadConfig", () => {
      loadConfig("ui");
      const goodText = fs.readFileSync(uiFile(), "utf8");
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      loadConfig("ui");
      expect(errors).toHaveBeenCalledTimes(1);
      fs.writeFileSync(uiFile(), goodText);
      reloadConfig("ui");
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      vi.advanceTimersByTime(INTERVAL_MS);
      loadConfig("ui");
      expect(errors).toHaveBeenCalledTimes(2);
    });

    it("is an error as before when the file is bad on the first read", () => {
      fs.writeFileSync(uiFile(), "trend_cycles: [unclosed\n");
      expect(() => loadConfig("ui")).toThrow(/not valid YAML/);
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe("saves from the page", () => {
    it("are visible to the next read at once, and a later refresh does not undo them", async () => {
      const before = loadConfig("ui");
      vi.advanceTimersByTime(INTERVAL_MS / 2);
      await writeConfig("ui", { ...before, trend_cycles: 15 });
      expect(loadConfig("ui").trend_cycles).toBe(15);
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui").trend_cycles).toBe(15);
      expect(refreshConfigCache().changed).toEqual([]);
    });
  });
});
