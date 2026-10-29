// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { closeStaleActivity, pruneActivityLog, reconcileActivity, startActivityMaintenance } from "@/lib/activity/maintenance";
import type { ActivityRecorder } from "@/lib/activity/types";
import type { Db } from "@/lib/db/client";
import { activityTablesReady, closeStaleSpans, openActivityConnection, pruneActivityBatch, reconcileActivitySpans } from "@/lib/db/repos/activity";
import { activitySettings } from "./helpers";

vi.mock("@/lib/db/repos/activity", async (original) => ({
  ...await original<typeof import("@/lib/db/repos/activity")>(),
  activityTablesReady: vi.fn(async () => true), closeStaleSpans: vi.fn(async () => 0), reconcileActivitySpans: vi.fn(async () => 0),
  pruneActivityBatch: vi.fn(async () => ({ roots: 0, events: 0, found: false, nextRootIds: null })),
}));
let recorder: ActivityRecorder;
const settings = activitySettings();
const end = vi.fn(async () => {});
const writeBatch = vi.fn(async () => {});
const warn = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(activityTablesReady).mockResolvedValue(true);
  vi.mocked(closeStaleSpans).mockResolvedValue(0);
  vi.mocked(reconcileActivitySpans).mockResolvedValue(0);
  vi.mocked(pruneActivityBatch).mockResolvedValue({ roots: 0, events: 0, found: false, nextRootIds: null });
  const db = {} as Db;
  recorder = createActivityRecorder({ db, process: "runner", autoFlush: false, loadSettings: () => settings, warn, writeBatch,
    openConnection: () => ({ db, sql: { end } }) as unknown as ReturnType<typeof openActivityConnection>,
  });
});
afterEach(async () => { const closing = recorder.close(); await vi.advanceTimersByTimeAsync(1000); await closing; vi.useRealTimers(); });

it("starts in the background, closes old spans before reconciliation and serializes periodic work", async () => {
  let resolve!: (count: number) => void;
  vi.mocked(closeStaleSpans).mockImplementationOnce(() => new Promise<number>((done) => { resolve = done; }));
  const stop = startActivityMaintenance({ recorder });
  await vi.advanceTimersByTimeAsync(0);
  expect(closeStaleSpans).toHaveBeenCalledWith(expect.anything(), { process: "runner", before: expect.any(Date) });
  expect(reconcileActivitySpans).not.toHaveBeenCalled();
  resolve(0); await vi.advanceTimersByTimeAsync(0);
  expect(reconcileActivitySpans).toHaveBeenCalledTimes(1);
  expect(pruneActivityBatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(settings.prune.every_minutes * 60_000);
  expect(reconcileActivitySpans).toHaveBeenCalledTimes(2); expect(pruneActivityBatch).toHaveBeenCalledTimes(2);
  stop.stop(); await vi.advanceTimersByTimeAsync(settings.prune.every_minutes * 60_000);
  expect(reconcileActivitySpans).toHaveBeenCalledTimes(2);
});

it.each([closeStaleActivity, reconcileActivity, pruneActivityLog])("bounds each maintenance operation and destroys a hung connection", async (operation) => {
  vi.mocked(closeStaleSpans).mockImplementation(() => new Promise<number>(() => {}));
  vi.mocked(reconcileActivitySpans).mockImplementation(() => new Promise<number>(() => {}));
  vi.mocked(pruneActivityBatch).mockImplementation(() => new Promise(() => {}));
  const pending = operation(recorder);
  await vi.advanceTimersByTimeAsync(settings.writer.flush_deadline_ms);
  await expect(pending).resolves.toBeUndefined();
  expect(end).toHaveBeenCalledWith({ timeout: 0 }); expect(warn).toHaveBeenCalledTimes(1);
});

it("gives each prune batch its own deadline and records only nonempty summaries", async () => {
  await pruneActivityLog(recorder); await reconcileActivity(recorder); await recorder.flush();
  expect(writeBatch).not.toHaveBeenCalled();
  vi.mocked(pruneActivityBatch).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { roots: 0, events: 2, found: true, nextRootIds: ["11111111-1111-4111-8111-111111111111"] };
  }).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { roots: 1, events: 1, found: true, nextRootIds: null };
  });
  const pruning = pruneActivityLog(recorder);
  await vi.advanceTimersByTimeAsync(120); await pruning;
  expect(warn).not.toHaveBeenCalled();
  await recorder.flush(); expect(writeBatch).toHaveBeenCalledTimes(1);
});

it("serializes maintenance behind the current flush without sharing the business pool", async () => {
  let complete!: () => void;
  writeBatch.mockImplementationOnce(() => new Promise<void>((done) => { complete = done; }));
  recorder.cycleRoot(1);
  const flushing = recorder.flush(); await vi.advanceTimersByTimeAsync(0);
  const maintenance = reconcileActivity(recorder); await vi.advanceTimersByTimeAsync(0);
  expect(reconcileActivitySpans).not.toHaveBeenCalled();
  complete(); await flushing; await maintenance;
  expect(reconcileActivitySpans).toHaveBeenCalledTimes(1);
});
