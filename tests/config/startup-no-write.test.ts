// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureProfileFiles } from "@/lib/config";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";

import { inProcessConfigWriteLock } from "./in-process-lock";
import { makeTempConfig, type TempConfig } from "./helpers";

const { installClientAbortFilter, reportWebShippedConfig } = vi.hoisted(() => ({ installClientAbortFilter: vi.fn(), reportWebShippedConfig: vi.fn(async () => true) }));
vi.mock("@/lib/ops/client-aborts", () => ({ installClientAbortFilter }));
vi.mock("@/lib/ops/shipped-config", () => ({ reportWebShippedConfig }));

import { register } from "@/instrumentation";

const REPO = path.resolve(import.meta.dirname, "../..");

let tmp: TempConfig;
let acquired: number;
beforeEach(() => {
  tmp = makeTempConfig({ user: "empty" });
  acquired = 0;
  // a start-up that wrote anything would have to take the config write lock
  setConfigWriteLockProviderForTests(async (options) => {
    acquired += 1;
    return inProcessConfigWriteLock(options);
  });
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

describe("web start-up (register)", () => {
  it("writes nothing into an empty user config and profile directory, and says what is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await register();
    expect(fs.readdirSync(tmp.configDir)).toEqual([]);
    expect(fs.existsSync(tmp.profileDir) ? fs.readdirSync(tmp.profileDir) : []).toEqual([]);
    expect(acquired).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] \d+ user file\(s\) missing: reading the shipped defaults$/));
  });

  it("is silent about files when none is missing, and still writes nothing", async () => {
    tmp.cleanup();
    tmp = makeTempConfig({ user: "all" });
    await ensureProfileFiles();
    acquired = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = fs.readdirSync(tmp.configDir).sort();
    await register();
    expect(fs.readdirSync(tmp.configDir).sort()).toEqual(before);
    expect(acquired).toBe(0);
    expect(log.mock.calls.filter(([line]) => String(line).includes("user file(s) missing"))).toEqual([]);
  });

  it("does nothing outside the node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(installClientAbortFilter).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp.configDir)).toEqual([]);
  });
});

describe("process entry points", () => {
  // The runner's start-up cannot run in-process (database, schedulers): what it must not call is checked in its source.
  const WRITERS = ["ensureConfigFiles", "ensureProfileFiles", "writeConfig", "writeConfigText", "mutateConfig", "commitConfigFile", "atomicWrite", "ensurePendingSetupFile", "completeSetup", "markStep", "withConfigWriteLock"];

  it.each(["src/runner/index.ts", "src/instrumentation.ts", "src/ai-worker/index.ts"])("%s calls no function that writes the user's config or profile files", (file) => {
    const source = fs.readFileSync(path.join(REPO, file), "utf8");
    for (const writer of WRITERS) expect(source, `${file} mentions ${writer}`).not.toMatch(new RegExp(`\\b${writer}\\b`));
  });

  it("the runner logs what is missing instead of creating it", () => {
    const source = fs.readFileSync(path.join(REPO, "src/runner/index.ts"), "utf8");
    expect(source).toContain("plannedConfigFiles()");
    expect(source).toContain("user file(s) missing: reading the shipped defaults");
  });
});
