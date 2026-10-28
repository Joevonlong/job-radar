// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { configErrorKey, ConfigError, getUserConfigPath, mutateConfig, reloadConfig } from "@/lib/config";
import { withDirectoryWriteLock } from "@/lib/config/write-lock";
import { getDisplayTimeZone } from "@/lib/dashboard/context";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

it("waits for the directory lease before reading or transforming the file", async () => {
  const file = getUserConfigPath("search");
  const max = reloadConfig("search").max_per_group_per_location + 1;
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = withDirectoryWriteLock(tmp.configDir, async () => {
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

it.each(["frozen", "busy", "stale", "protected"] as const)("maps the %s write refusal consistently", (kind) => {
  expect(configErrorKey(new ConfigError({ configName: "search", filePath: "search.yaml", kind }))).toBe(kind);
});

it("uses UTC for display when the schedule starts invalid", () => {
  fs.writeFileSync(getUserConfigPath("schedule"), "timezone: [invalid\n");
  expect(getDisplayTimeZone()).toBe("UTC");
});
