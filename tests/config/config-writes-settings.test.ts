// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { configRegistry, loadConfig, resetConfigCache, writeConfig } from "@/lib/config";
import { configWriteSettings, setConfigWriteLockProviderForTests, withConfigWriteLock } from "@/lib/config/write-lock";

import { inProcessConfigWriteLock } from "./in-process-lock";
import { makeTempConfig, shippedYaml, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => {
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

/** The schema of the block (its defaults are what a missing or unreadable schedule.yaml falls back to). */
const schema = () => configRegistry.schedule.schema.shape.config_writes;
const schedulePath = () => path.join(tmp.configDir, "schedule.yaml");

function editSchedule(edit: (value: Record<string, unknown>) => void): void {
  const value = parse(fs.readFileSync(schedulePath(), "utf8")) as Record<string, unknown>;
  edit(value);
  fs.writeFileSync(schedulePath(), stringify(value));
  resetConfigCache();
}

/** The `waitSeconds` the lock is asked for. */
function recordWait(): number[] {
  const waits: number[] = [];
  setConfigWriteLockProviderForTests(async (options) => {
    waits.push(options.waitSeconds);
    return inProcessConfigWriteLock(options);
  });
  return waits;
}

describe("schedule.yaml: config_writes", () => {
  const scheduleSchema = configRegistry.schedule.schema;
  const base = () => structuredClone(shippedYaml("schedule.yaml"));

  it("a file without the block gets the defaults (the block is not listed in the shipped file)", () => {
    const raw = base();
    delete raw.config_writes;
    const parsed = scheduleSchema.parse(raw).config_writes;
    expect(parsed).toEqual({ backups_keep: expect.any(Number), lock_wait_seconds: expect.any(Number) });
    expect(parsed.backups_keep).toBeGreaterThanOrEqual(1);
    expect(parsed.lock_wait_seconds).toBeGreaterThanOrEqual(1);
  });

  it("takes the values the user writes", () => {
    const raw = base();
    raw.config_writes = { backups_keep: 2, lock_wait_seconds: 30 };
    expect(scheduleSchema.parse(raw).config_writes).toEqual({ backups_keep: 2, lock_wait_seconds: 30 });
  });

  it.each([
    ["backups_keep 0", { backups_keep: 0 }],
    ["backups_keep fractional", { backups_keep: 1.5 }],
    ["lock_wait_seconds below 1", { lock_wait_seconds: 0.5 }],
    ["an unknown key", { typo: 1 }],
  ])("rejects %s", (_name, block) => {
    const raw = base();
    raw.config_writes = block;
    expect(scheduleSchema.safeParse(raw).success).toBe(false);
  });

  it("still accepts the lease keys of earlier versions under deploy, and ignores them", () => {
    const raw = base();
    Object.assign(raw.deploy as Record<string, unknown>, { config_write_lock_stale_seconds: 600, config_write_lock_wait_seconds: 60, config_write_lock_retry_ms: 50 });
    const parsed = scheduleSchema.parse(raw);
    expect(parsed.config_writes).toEqual(scheduleSchema.parse(base()).config_writes);
  });
});

describe("configWriteSettings", () => {
  it("reads schedule.yaml", () => {
    editSchedule((value) => { value.config_writes = { backups_keep: 7, lock_wait_seconds: 3 }; });
    expect(configWriteSettings()).toEqual({ backups_keep: 7, lock_wait_seconds: 3 });
  });

  it("falls back to the defaults when schedule.yaml is invalid, so a repair can still be saved", async () => {
    const defaults = schema().parse(undefined);
    fs.writeFileSync(schedulePath(), "config_writes: {backups_keep: 0}\nnot valid: [\n");
    resetConfigCache();
    expect(() => loadConfig("schedule")).toThrow();
    expect(configWriteSettings()).toEqual(defaults);

    // a form save of another file goes through while schedule.yaml is broken
    const ui = structuredClone(loadConfig("ui"));
    ui.ticker_max_items = 3;
    const waits = recordWait();
    await expect(writeConfig("ui", ui)).resolves.toMatchObject({ ticker_max_items: 3 });
    expect(waits).toEqual([defaults.lock_wait_seconds]);
  });

  it("falls back to the defaults when schedule.yaml is missing from both layers", () => {
    fs.rmSync(schedulePath());
    fs.rmSync(path.join(tmp.defaultsDir, "schedule.yaml"));
    resetConfigCache();
    expect(configWriteSettings()).toEqual(schema().parse(undefined));
  });
});

describe("the wait for the lock", () => {
  it("is `config_writes.lock_wait_seconds`", async () => {
    editSchedule((value) => { value.config_writes = { backups_keep: 5, lock_wait_seconds: 4 }; });
    const waits = recordWait();
    await withConfigWriteLock(async () => {}, schedulePath());
    expect(waits).toEqual([4]);
  });
});
