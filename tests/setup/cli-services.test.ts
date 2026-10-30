// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as workerLabel from "@/lib/ops/ai-worker-label";
import * as probes from "@/lib/ops/doctor/probes";
import { runSetupCli } from "@/lib/setup/cli";
import { resetSetupStateCache } from "@/lib/setup/state";
import { runTelegramSetup } from "@/lib/setup/telegram-setup";

import { makeTempConfig, type TempConfig } from "../config/helpers";

vi.mock("@/lib/setup/telegram-setup", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/setup/telegram-setup")>(),
  runTelegramSetup: vi.fn(async () => "skipped"),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let tmp: TempConfig;

beforeEach(() => {
  tmp = makeTempConfig();
  resetSetupStateCache();
  vi.mocked(runTelegramSetup).mockClear();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  tmp.cleanup();
  resetSetupStateCache();
});

async function setupServices(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  const io = { out: vi.fn(), err: vi.fn(), ask: async () => null };
  expect(await runSetupCli(["--step", "telegram", "--lang", "en"], io, { NODE_ENV: "test", DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none" })).toBe(0);
  expect(runTelegramSetup).toHaveBeenCalledOnce();
  return vi.mocked(runTelegramSetup).mock.calls[0]![0].services;
}

describe("setup host service controls", () => {
  it.each(["linux", "freebsd"] as const)("keeps service controls on %s when launchd label resolution is unavailable", async (platform) => {
    const resolver = vi.spyOn(workerLabel, "aiWorkerLaunchdLabel").mockImplementation(() => { throw new Error("unavailable"); });
    const run = vi.spyOn(probes, "runCommand").mockResolvedValue({ kind: "ran", exitCode: 0, stdout: "active\n", stderr: "" });
    const services = await setupServices(platform);
    expect(services).not.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
    expect(await services!.aiWorker()).toBe(platform === "linux" ? "systemd" : null);
    if (platform === "linux") {
      expect(await services!.restartAiWorker("systemd")).toEqual({ ok: true, reason: "" });
      expect(run).toHaveBeenCalledWith("systemctl", ["--user", "restart", services!.settings.systemdUnit], expect.any(Number), { detached: true });
    } else {
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("uses the resolved label for launchd controls on macOS", async () => {
    const resolver = vi.spyOn(workerLabel, "aiWorkerLaunchdLabel").mockReturnValue("org.example.worker");
    const run = vi.spyOn(probes, "runCommand").mockResolvedValue({ kind: "ran", exitCode: 0, stdout: "", stderr: "" });
    const services = await setupServices("darwin");
    expect(resolver).toHaveBeenCalledOnce();
    expect(services).not.toBeNull();
    expect(await services!.aiWorker()).toBe("launchd");
    expect(run).toHaveBeenCalledWith("launchctl", ["print", `gui/${services!.settings.uid}/org.example.worker`], expect.any(Number), { detached: true });
  });
});
