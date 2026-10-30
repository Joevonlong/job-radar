// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { startActivityMaintenance } from "@/lib/activity/maintenance";
import type { ActivityRecorder } from "@/lib/activity/types";
import type { Db } from "@/lib/db/client";
import { closeStaleSpans, openActivityConnection, reconcileActivitySpans } from "@/lib/db/repos/activity";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { activitySettings } from "./helpers";

vi.mock("@/lib/db/repos/activity", async (original) => ({
  ...await original<typeof import("@/lib/db/repos/activity")>(), activityTablesReady: vi.fn(async () => true),
  closeStaleSpans: vi.fn(async () => 0), reconcileActivitySpans: vi.fn(async () => 0),
  pruneActivityBatch: vi.fn(async () => ({ roots: 0, events: 0, found: false, nextRootIds: null })),
}));
// Test the real config polling path, without relying on OS file-watch delivery in a sandbox.
vi.mock("@/lib/config/watch", async (original) => {
  const real = await original<typeof import("@/lib/config/watch")>();
  return { ...real, watchConfig: (...args: Parameters<typeof real.watchConfig>) => real.watchConfig(args[0], args[1], { ...args[2], fsWatch: false }) };
});
let temp: TempConfig | undefined;
let recorder: ActivityRecorder | undefined;
let maintenance: ReturnType<typeof startActivityMaintenance> | undefined;
afterEach(async () => {
  maintenance?.stop();
  const closing = recorder?.close(); await vi.advanceTimersByTimeAsync(1000); await closing;
  temp?.cleanup(); vi.useRealTimers();
});

it("recovers a cold invalid file and starts flush/maintenance timers without a manual flush", async () => {
  vi.useFakeTimers();
  temp = makeTempConfig(); process.env.JOB_RADAR_CONFIG_POLL_MS = "10";
  const file = path.join(temp.configDir, "activity-log.yaml");
  fs.writeFileSync(file, "enabled: invalid\n");
  const db = {} as Db;
  const writeBatch = vi.fn(async () => {});
  const warn = vi.fn();
  recorder = createActivityRecorder({ db, process: "runner", writeBatch, warn,
    openConnection: () => ({ db, sql: { end: async () => {} } }) as unknown as ReturnType<typeof openActivityConnection>,
  });
  maintenance = startActivityMaintenance({ recorder });
  await vi.advanceTimersByTimeAsync(0);
  expect(recorder.enabled).toBe(false); expect(warn).toHaveBeenCalledTimes(1);
  expect(closeStaleSpans).not.toHaveBeenCalled();
  const settings = activitySettings();
  settings.writer.flush_ms = 1000;
  fs.writeFileSync(file, YAML.stringify(settings));
  await vi.advanceTimersByTimeAsync(400);
  expect(recorder.enabled).toBe(true);
  expect(closeStaleSpans).toHaveBeenCalledTimes(1); expect(reconcileActivitySpans).toHaveBeenCalledTimes(1);
  recorder.systemRoot("system.backup").finish("ok");
  await vi.advanceTimersByTimeAsync(settings.writer.flush_ms);
  expect(writeBatch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(settings.prune.every_minutes * 60_000);
  expect(reconcileActivitySpans).toHaveBeenCalledTimes(2);
});
