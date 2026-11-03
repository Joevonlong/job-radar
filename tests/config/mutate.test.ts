// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { configErrorKey, ConfigError, getUserConfigPath, mutateConfig, reloadConfig } from "@/lib/config";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { getDisplayTimeZone } from "@/lib/dashboard/context";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

it("waits for the config write lock before reading or transforming the file", async () => {
  const file = getUserConfigPath("search");
  const max = reloadConfig("search").max_per_group_per_location + 1;
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = withConfigWriteLock(async () => {
    enter();
    await gate;
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    doc.set("max_per_group_per_location", max);
    fs.writeFileSync(file, String(doc));
  });
  await entered;
  const update = vi.fn((current: ReturnType<typeof reloadConfig<"search">>) => ({ ...current, locations: ["Austin"] }));
  const mutation = mutateConfig("search", update);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(update).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await writer;
  await mutation;
  expect(reloadConfig("search")).toMatchObject({ locations: ["Austin"], max_per_group_per_location: max });
});

it("a declined edit keeps the exact file text", async () => {
  const file = getUserConfigPath("search");
  const text = fs.readFileSync(file, "utf8");
  expect(await mutateConfig("search", () => null)).toBeNull();
  expect(fs.readFileSync(file, "utf8")).toBe(text);
});

it.each([
  ["busy", "busy"],
  ["stale", "stale"],
  ["protected", "protected"],
  ["db_unavailable", "dbUnavailable"],
] as const)("maps the %s write refusal consistently", (kind, key) => {
  expect(configErrorKey(new ConfigError({ configName: "search", filePath: "search.yaml", kind }))).toBe(key);
});

it("uses UTC for display when the schedule starts invalid", () => {
  fs.writeFileSync(getUserConfigPath("schedule"), "timezone: [invalid\n");
  expect(getDisplayTimeZone()).toBe("UTC");
});

it("does not replace a file that a bind mount keeps hiding: the save fails, the file stays", async () => {
  const file = getUserConfigPath("search");
  const before = fs.readFileSync(file, "utf8");
  const max = reloadConfig("search").max_per_group_per_location + 1;
  const realRead = fs.readFileSync;
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(((target: Parameters<typeof realRead>[0], options: Parameters<typeof realRead>[1]) => {
    if (target === file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return realRead(target, options);
  }) as typeof realRead);
  const start = Date.now();
  let calls = 0;
  const now = vi.spyOn(Date, "now").mockImplementation(() => start + 60_000 * calls++);
  try {
    const error = await mutateConfig("search", (current) => ({ ...current, max_per_group_per_location: max })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("search.yaml");
  } finally {
    read.mockRestore();
    now.mockRestore();
  }
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(tmp.configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
