// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configRegistry } from "@/lib/config";
import { mergeLayers } from "@/lib/config/merge";
import { applyOverlayEdits } from "@/lib/config/overlay-diff";
import { overlaySaveEdits } from "@/lib/config/overlay";
import { replaceRule } from "@/lib/config/overlay-rules";
import { currentConfigVersion, loadConfig, reloadConfig, watchConfig, writeConfig, type ConfigChangeEvent } from "@/lib/config";
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

describe("a changed shipped value reaches the watcher and the web, whatever else the overlay holds", () => {
  const INTERVAL_MS = 1000;
  const stops: Array<() => void> = [];
  const shippedFile = (file: string) => path.join(temp.defaultsDir, file);
  const userFile = (file: string) => path.join(temp.configDir, file);

  beforeEach(() => {
    // the overlays hold other keys than the ones the shipped files change below
    fs.writeFileSync(userFile("ai.yaml"), `config_version: ${currentConfigVersion("ai")}\napi_timeout_seconds: 61\n`);
    fs.writeFileSync(userFile("schedule.yaml"), `config_version: ${currentConfigVersion("schedule")}\ntimezone: UTC\n`);
  });
  afterEach(() => {
    while (stops.length > 0) stops.pop()?.();
    delete process.env.JOB_RADAR_CONFIG_POLL_MS;
    vi.useRealTimers();
  });

  /** A new release: the shipped task order of salary_lookup and the daily backup count differ. */
  function shipNewValues(): void {
    const ai = shippedFile("ai.yaml");
    const aiDoc = parseDocument(fs.readFileSync(ai, "utf8"));
    aiDoc.setIn(["tasks", "salary_lookup"], aiDoc.createNode({ order: ["codex-cli"] }));
    fs.writeFileSync(ai, aiDoc.toString());
    const schedule = shippedFile("schedule.yaml");
    fs.writeFileSync(schedule, fs.readFileSync(schedule, "utf8").replace(/^(\s*keep_daily:\s*)\d+/m, "$1321"));
  }

  it("the watcher emits both configs with the new shipped values and the overlay values intact", async () => {
    vi.useFakeTimers();
    expect(loadConfig("ai").tasks.salary_lookup.order).toEqual(["claude-cli", "anthropic"]);
    expect(loadConfig("schedule").backup.keep_daily).not.toBe(321);
    const events: ConfigChangeEvent[] = [];
    const errors: unknown[] = [];
    stops.push(watchConfig(["ai", "schedule"], (event) => events.push(event), { debounceMs: 20, pollMs: 80, fsWatch: false, onError: (e) => errors.push(e) }));
    shipNewValues();
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toEqual([]);
    expect(events.map((event) => event.name).sort()).toEqual(["ai", "schedule"]);
    const ai = events.find((event) => event.name === "ai")?.value as ReturnType<typeof loadConfig<"ai">>;
    const schedule = events.find((event) => event.name === "schedule")?.value as ReturnType<typeof loadConfig<"schedule">>;
    expect(ai.tasks.salary_lookup.order).toEqual(["codex-cli"]);
    expect(ai.api_timeout_seconds).toBe(61);
    expect(schedule.backup.keep_daily).toBe(321);
    expect(schedule.timezone).toBe("UTC");
  });

  it("the web's next loadConfig after the throttle interval returns the new shipped values", () => {
    process.env.JOB_RADAR_CONFIG_POLL_MS = String(INTERVAL_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    loadConfig("ai");
    loadConfig("schedule");
    shipNewValues();
    // within the interval the cache is served
    expect(loadConfig("schedule").backup.keep_daily).not.toBe(321);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loadConfig("ai").tasks.salary_lookup.order).toEqual(["codex-cli"]);
    expect(loadConfig("ai").api_timeout_seconds).toBe(61);
    expect(loadConfig("schedule").backup.keep_daily).toBe(321);
    expect(loadConfig("schedule").timezone).toBe("UTC");
  });
});
