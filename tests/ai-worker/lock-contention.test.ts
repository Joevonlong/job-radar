// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@/lib/config";
import { aiWorkerLaunchdLabel } from "@/lib/ops/ai-worker-label";
import { exitProcess } from "@/lib/ops/shutdown";

import { makeTempConfig, type TempConfig } from "../config/helpers";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/instance-lock", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db/instance-lock")>(),
  acquireInstanceLock: vi.fn(async () => ({ acquired: false, holder: null })),
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock("@/lib/ops/ai-worker-label", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ops/ai-worker-label")>(),
  aiWorkerLaunchdLabel: vi.fn(() => { throw new Error("invalid label"); }),
}));
vi.mock("@/lib/ops/shutdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ops/shutdown")>(),
  exitProcess: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArgv = process.argv;
let tmp: TempConfig;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  tmp = makeTempConfig({ user: "empty" });
  for (const [name, keys, value] of [
    ["ai", ["host_worker", "already_running_wait_seconds"], 7],
    ["schedule", ["doctor", "ai_worker_launchd_label"], "invalid label"],
  ] as const) {
    const file = path.join(tmp.defaultsDir, `${name}.yaml`);
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    doc.setIn(keys, value);
    fs.writeFileSync(file, doc.toString());
  }
});
afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  tmp.cleanup();
});

describe.each(["darwin", "linux", "freebsd"] as const)("worker lock contention on %s", (platform) => {
  it.each([true, false])("keeps exit code 3 and its wait when label resolution fails (once=%s)", async (once) => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    process.argv = [process.execPath, "ai-worker", ...(once ? ["--once"] : [])];
    await import("@/ai-worker/index");
    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledExactlyOnceWith(3));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`another ai-worker is running against this database: exiting${once ? "" : " in 7s"}`));
    if (once) expect(sleep).not.toHaveBeenCalled();
    else {
      expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
      expect(vi.mocked(sleep).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(exitProcess).mock.invocationCallOrder[0]!);
    }
    if (platform === "darwin") {
      expect(aiWorkerLaunchdLabel).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("launchctl bootout gui/$(id -u)/<label>"));
    } else {
      expect(aiWorkerLaunchdLabel).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalledWith("schedule");
    }
  });
});
