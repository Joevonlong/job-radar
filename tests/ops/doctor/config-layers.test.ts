// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configLayersCheck, configMarketCheck } from "@/lib/ops/doctor/checks/config";
import type { ConfigFileOverlay, ConfigLayersState } from "@/lib/config";

import { configLayersState, makeContext, marketSummary, only } from "./helpers";

const entry = (path: string, edit: Partial<ConfigFileOverlay["entries"][number]> = {}): ConfigFileOverlay["entries"][number] => ({ path, kind: "override", pin: false, invalid: false, protected: false, shown: "1", ...edit });
const overlayFile = (file: string, entries: ConfigFileOverlay["entries"]): ConfigFileOverlay => ({
  name: "schedule",
  file,
  format: "overlay",
  overrides: entries.filter((e) => e.kind === "override").length,
  unsets: entries.filter((e) => e.kind === "unset").length,
  pins: entries.filter((e) => e.pin).length,
  invalidUnsets: entries.filter((e) => e.invalid).length,
  entries,
});

const check = (edit: Partial<ConfigLayersState> = {}) => only(configLayersCheck, makeContext({ probes: { configLayers: async () => configLayersState(edit) } }));

describe("config.layers", () => {
  it("is ok with a writable, current user directory and names both directories", async () => {
    const result = await check();
    expect(result).toMatchObject({ id: "config.layers", group: "data", status: "ok" });
    expect(result.detail).toBe("用户配置 data/config（10 个文件），默认配置 config");
  });

  it("fails when the user directory is missing or read-only, with the command that fixes it", async () => {
    const missing = await check({ userDirExists: false, userDirWritable: null });
    expect(missing.status).toBe("fail");
    expect(missing.hint).toContain("pnpm config:init");
    const readOnly = await check({ userDirWritable: false });
    expect(readOnly.status).toBe("fail");
    expect(readOnly.detail).toContain("不可写");
  });

  it("warns about user files without config_version: keys they lack take the schema's defaults", async () => {
    const result = await check({ missingVersion: ["ai.yaml"] });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("ai.yaml 没有 config_version");
    expect(result.hint).toContain("config:plan --deploy");
  });

  it("warns about files behind the code and says to run config:migrate --write", async () => {
    const result = await check({ pendingMigrations: [{ file: "data/config/interests.yaml", from: 1, to: 2 }] });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("data/config/interests.yaml（版本 1 → 2）");
    expect(result.hint).toContain("pnpm config:migrate --write");
  });

  it("fails for a file newer than the code (a downgrade), warns for files not copied yet", async () => {
    const newer = await check({ problems: [{ file: "data/config/ui.yaml", message: "config_version 3 is newer …" }] });
    expect(newer.status).toBe("fail");
    expect(newer.hint).toContain(".backup");
    const notCopied = await check({ notCopied: ["ui.yaml"] });
    expect(notCopied.status).toBe("warn");
    expect(notCopied.hint).toContain("pnpm config:init");
  });

  describe("overlay report", () => {
    const healthy = [overlayFile("data/config/schedule.yaml", [entry("backup.keep_daily"), entry("backup.cron"), entry("catch_up", { kind: "unset", shown: null })])];

    it("puts the override and unset counts in the summary and stays ok", async () => {
      const result = await check({ overlays: healthy });
      expect(result.status).toBe("ok");
      expect(result.detail).toBe("用户配置 data/config（10 个文件；覆盖 2 个键，取消 1 个键），默认配置 config");
    });

    it("says in English too", async () => {
      const result = await only(configLayersCheck, makeContext({ locale: "en", probes: { configLayers: async () => configLayersState({ overlays: healthy }) } }));
      expect(result.detail).toBe("User config data/config (10 files; 2 overrides, 1 unset), defaults config");
    });

    it("mentions a pin at the shipped value as information, never as a problem", async () => {
      const result = await check({ overlays: [overlayFile("data/config/ui.yaml", [entry("trend_cycles", { pin: true })])] });
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("data/config/ui.yaml trend_cycles");
      expect(result.hint).toBeUndefined();
    });

    it("warns about an unset of a key the shipped file lacks, in both languages", async () => {
      const overlays = [overlayFile("data/config/ui.yaml", [entry("old_key", { kind: "unset", invalid: true, shown: null })])];
      const zh = await check({ overlays });
      expect(zh.status).toBe("warn");
      expect(zh.detail).toContain("data/config/ui.yaml old_key");
      expect(zh.hint).toContain("config:check --overrides");
      const en = await only(configLayersCheck, makeContext({ locale: "en", probes: { configLayers: async () => configLayersState({ overlays }) } }));
      expect(en.status).toBe("warn");
      expect(en.detail).toContain("1 unset names a key the shipped file does not have, so it does nothing");
    });

    it("lists at most five keys", async () => {
      const entries = Array.from({ length: 8 }, (_, i) => entry(`k${i}`, { pin: true }));
      const result = await check({ overlays: [overlayFile("data/config/ui.yaml", entries)] });
      expect(result.detail).toContain("k4");
      expect(result.detail).not.toContain("k5");
      expect(result.detail).toContain("…");
    });

    it("a whole file or an unreadable one adds nothing to the counts", async () => {
      const whole: ConfigFileOverlay = { name: "ui", file: "data/config/ui.yaml", format: "whole", overrides: 0, unsets: 0, pins: 0, invalidUnsets: 0, entries: [] };
      const result = await check({ overlays: [whole] });
      expect(result.status).toBe("ok");
      expect(result.detail).toBe("用户配置 data/config（10 个文件），默认配置 config");
    });

    it("a user copy of a market pack still warns (config.market)", async () => {
      const result = await only(configMarketCheck, makeContext({ probes: { market: async () => marketSummary({ packLayer: "user" }) } }));
      expect(result.status).toBe("warn");
      expect(result.hint).toBeTruthy();
    });
  });
});
