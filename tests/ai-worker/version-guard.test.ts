// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentConfigVersion, getUserConfigPath } from "@/lib/config";

import { hostWorkerSettings, newerConfigFiles, type VersionCache } from "../../src/ai-worker/version-guard";
import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig;

beforeEach(() => {
  temp = makeTempConfig({ user: "init" });
});

afterEach(() => {
  vi.restoreAllMocks();
  temp.cleanup();
});

function writeNewer(): string {
  const file = getUserConfigPath("notify");
  fs.writeFileSync(file, `config_version: ${currentConfigVersion("notify") + 1}\n`);
  return file;
}

describe("newerConfigFiles", () => {
  it("reads a file again after a failed read, though its stat has not changed", () => {
    const file = writeNewer();
    const cache: VersionCache = new Map();
    const realRead = fs.readFileSync;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw Object.assign(new Error("input/output error"), { code: "EIO" });
      return realRead(...args);
    }) as typeof fs.readFileSync);

    expect(newerConfigFiles(cache).map((entry) => entry.name)).not.toContain("notify");

    read.mockRestore();
    expect(newerConfigFiles(cache).map((entry) => entry.name)).toContain("notify");
  });

  it("reads a file again after YAML it could not parse, though its stat has not changed", () => {
    const file = getUserConfigPath("notify");
    const newer = `config_version: ${currentConfigVersion("notify") + 1}\n`;
    fs.writeFileSync(file, newer.replace(":", ": [")); // one byte longer than the good text
    const cache: VersionCache = new Map();
    expect(newerConfigFiles(cache).map((entry) => entry.name)).not.toContain("notify");

    const stat = fs.statSync(file);
    fs.writeFileSync(file, `${newer} `); // the same size
    fs.utimesSync(file, stat.atime, stat.mtime);

    expect(newerConfigFiles(cache).map((entry) => entry.name)).toContain("notify");
  });

  it("does not read a file again whose read succeeded and whose stat has not changed", () => {
    writeNewer();
    const cache: VersionCache = new Map();
    newerConfigFiles(cache);
    const read = vi.spyOn(fs, "readFileSync");

    newerConfigFiles(cache);

    expect(read.mock.calls.filter(([file]) => file === getUserConfigPath("notify"))).toEqual([]);
  });
});

describe("hostWorkerSettings", () => {
  it("falls back to the shipped values when the user's ai.yaml cannot be loaded", () => {
    fs.writeFileSync(getUserConfigPath("ai"), `config_version: ${currentConfigVersion("ai") + 1}\n`);

    expect(hostWorkerSettings().already_running_wait_seconds).toBeGreaterThan(0);
  });
});
