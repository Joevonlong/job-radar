import { describe, expect, it } from "vitest";

import type { CommandOutcome } from "@/lib/ops/doctor/types";
import { createServiceControl, type ServiceSettings } from "@/lib/ops/services";

const settings: ServiceSettings = { project: "radar-two", platform: "darwin", uid: 501, launchdLabel: "io.example.worker", systemdUnit: "example-worker.service", commandTimeoutMs: 1000, restartWaitSeconds: 90 };

function recorder(answer: (command: string, args: readonly string[]) => CommandOutcome = () => ({ kind: "ran", exitCode: 0, stdout: "", stderr: "" })) {
  const calls: string[] = [];
  return {
    calls,
    run: async (command: string, args: readonly string[]) => {
      calls.push([command, ...args].join(" "));
      return answer(command, args);
    },
  };
}

describe("createServiceControl", () => {
  it("uses the compose project and recreates (not restarts) so .env is read again", async () => {
    const r = recorder((_c, args) => ({ kind: "ran", exitCode: 0, stdout: args.includes("ps") ? "db\nweb\nrunner\n" : "", stderr: "" }));
    const control = createServiceControl(settings, r.run);
    expect(await control.runningServices()).toEqual(["db", "web", "runner"]);
    await control.stop("runner");
    await control.start("runner");
    await control.recreate(["web", "runner"]);
    expect(r.calls).toEqual([
      "docker compose -p radar-two ps --status running --services",
      "docker compose -p radar-two stop runner",
      "docker compose -p radar-two start runner",
      "docker compose -p radar-two up -d --no-deps --force-recreate --wait --wait-timeout 90 web runner",
    ]);
  });

  it("Docker not answering: no running list; a failure carries the last error line", async () => {
    const control = createServiceControl(settings, recorder(() => ({ kind: "ran", exitCode: 1, stdout: "", stderr: "pulling\nCannot connect to the Docker daemon\n" })).run);
    expect(await control.runningServices()).toBeNull();
    expect(await control.recreate(["web"])).toEqual({ ok: false, reason: "Cannot connect to the Docker daemon" });
    expect(await createServiceControl(settings, recorder(() => ({ kind: "missing" })).run).stop("runner")).toEqual({ ok: false, reason: "docker compose stop not found" });
  });

  it("macOS: kickstarts the loaded launchd agent; nothing when it is not loaded", async () => {
    const r = recorder();
    const control = createServiceControl(settings, r.run);
    expect(await control.aiWorker()).toBe("launchd");
    await control.restartAiWorker("launchd");
    expect(r.calls).toEqual(["launchctl print gui/501/io.example.worker", "launchctl kickstart -k gui/501/io.example.worker"]);
    expect(await createServiceControl(settings, recorder(() => ({ kind: "ran", exitCode: 113, stdout: "", stderr: "" })).run).aiWorker()).toBeNull();
  });

  it("Linux: restarts the active systemd user unit", async () => {
    const r = recorder(() => ({ kind: "ran", exitCode: 0, stdout: "active\n", stderr: "" }));
    const control = createServiceControl({ ...settings, platform: "linux" }, r.run);
    expect(await control.aiWorker()).toBe("systemd");
    await control.restartAiWorker("systemd");
    expect(r.calls).toEqual(["systemctl --user is-active example-worker.service", "systemctl --user restart example-worker.service"]);
  });

  it("prints the same steps as commands for doing it by hand", () => {
    const control = createServiceControl(settings, recorder().run);
    expect(control.manualCommands(["web", "runner"], "unknown")).toEqual(["docker compose -p radar-two up -d --no-deps --force-recreate web runner", "launchctl kickstart -k gui/501/io.example.worker"]);
    expect(createServiceControl({ ...settings, platform: "linux" }, recorder().run).manualCommands([], "systemd")).toEqual(["systemctl --user restart example-worker.service"]);
    expect(control.manualCommands([], null)).toEqual([]);
  });
});
