// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentConfigVersion, loadConfig } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const INTERVAL_MS = 5000;
const user = (): string => path.join(temp.configDir, "ui.yaml");
const shipped = (): string => path.join(temp.defaultsDir, "ui.yaml");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  process.env.JOB_RADAR_CONFIG_POLL_MS = String(INTERVAL_MS);
  temp = makeTempConfig({ user: "empty" });
  fs.writeFileSync(user(), `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: 5\n`);
});
afterEach(() => {
  temp.cleanup();
  delete process.env.JOB_RADAR_CONFIG_POLL_MS;
  vi.useRealTimers();
});

describe("the lazy refresh looks at both layers", () => {
  it("a change in the shipped file reaches a process with a user file", () => {
    const start = loadConfig("ui").config_editor.backups_keep;
    fs.writeFileSync(shipped(), fs.readFileSync(shipped(), "utf8").replace(/^(\s*backups_keep:\s*)\d+/m, `$1${start + 7}`));
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").config_editor.backups_keep).toBe(start + 7);
    expect(loadConfig("ui").trend_cycles).toBe(5);
  });

  it("a change in the user file too, and its removal goes back to the shipped value", () => {
    loadConfig("ui");
    fs.writeFileSync(user(), `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: 6\n`);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").trend_cycles).toBe(6);
    fs.rmSync(user());
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").trend_cycles).not.toBe(6);
  });

  describe("a user file that stays invalid", () => {
    const BAD = `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: nope\n`;
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it("is reported again when the shipped file changes and the merged result is still invalid; unchanged inputs report nothing more", () => {
      const good = loadConfig("ui");
      fs.writeFileSync(user(), BAD);
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("ui");

      // nothing changed: the same inputs are not reported again
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(1);

      // the shipped side changes (a valid value) and the merged result is invalid as before: a new input, reported again
      fs.writeFileSync(shipped(), fs.readFileSync(shipped(), "utf8").replace(/^(\s*backups_keep:\s*)\d+/m, `$1${good.config_editor.backups_keep + 3}`));
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(2);

      // and again nothing more while both layers stay as they are
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(loadConfig("ui")).toBe(good);
      expect(errors).toHaveBeenCalledTimes(2);
    });
  });

  it("a broken shipped file keeps the last good value", () => {
    loadConfig("ui");
    fs.writeFileSync(shipped(), "a: [\n");
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ui").trend_cycles).toBe(5);
  });
});
