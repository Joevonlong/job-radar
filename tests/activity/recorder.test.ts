// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { noopRecorder, noopSpan } from "@/lib/activity/noop";
import type { ActivityBatch, ActivityRecorder, ItemEventCode } from "@/lib/activity/types";
import type { Db } from "@/lib/db/client";
import type { ActivityLogConfig } from "@/lib/config/schemas/activity-log";
import { activityTablesReady, openActivityConnection } from "@/lib/db/repos/activity";
import { activitySettings } from "./helpers";

vi.mock("@/lib/db/repos/activity", async (original) => ({
  ...await original<typeof import("@/lib/db/repos/activity")>(), activityTablesReady: vi.fn(async () => true),
}));

const recorders: ActivityRecorder[] = [];
function setup(overrides: Partial<Parameters<typeof createActivityRecorder>[0]> = {}) {
  const settings = activitySettings();
  const batches: ActivityBatch[] = [];
  const writeBatch = vi.fn(async (_db: Db, batch: ActivityBatch) => { batches.push(structuredClone(batch)); });
  const end = vi.fn(async () => {});
  const db = {} as Db;
  // The writer only owns the connection's db and end capabilities; no database driver is called here.
  const openConnection = vi.fn(() => ({ db, sql: { end } }) as unknown as ReturnType<typeof openActivityConnection>);
  const warn = vi.fn();
  const recorder = createActivityRecorder({ db, process: "runner", autoFlush: false, loadSettings: () => settings, writeBatch, openConnection, warn, ...overrides });
  recorders.push(recorder);
  return { recorder, settings, batches, writeBatch, end, openConnection, warn };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-01T00:00:00Z")); vi.mocked(activityTablesReady).mockResolvedValue(true); });
afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    const closing = recorder.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
  }
  vi.useRealTimers();
});

describe("activity recorder", () => {
  it.each(["connect_timeout_seconds", "statement_timeout_ms", "lock_timeout_ms"] as const)("rebuilds changed %s only after the current batch finishes", async (key) => {
    const { recorder, settings, writeBatch, openConnection, end } = setup();
    let complete!: () => void;
    writeBatch.mockImplementationOnce(() => new Promise<void>((done) => { complete = done; }));
    const root = recorder.cycleRoot(1);
    const pending = recorder.flush(); await vi.advanceTimersByTimeAsync(0);
    expect(openConnection).toHaveBeenCalledTimes(1);
    settings.writer[key] += 1;
    root.progress(1); // Reload while the old connection still owns a batch.
    expect(end).not.toHaveBeenCalled();
    expect(openConnection).toHaveBeenCalledTimes(1);
    complete(); await pending;
    await recorder.flush();
    expect(end).toHaveBeenCalledTimes(1);
    expect(openConnection).toHaveBeenCalledTimes(2);
    expect(openConnection).toHaveBeenLastCalledWith(expect.anything(), {
      connectTimeoutSeconds: settings.writer.connect_timeout_seconds,
      statementTimeoutMs: settings.writer.statement_timeout_ms,
      lockTimeoutMs: settings.writer.lock_timeout_ms,
    });
    root.progress(2); await recorder.flush();
    expect(openConnection).toHaveBeenCalledTimes(2);
  });
  it("merges progress and keeps the first terminal state and time", async () => {
    const { recorder, batches } = setup();
    const root = recorder.cycleRoot(1);
    root.progress(1, 5); root.progress(3, 5); root.finish("partial");
    root.progress(4); root.finish("ok");
    await recorder.flush();
    expect(batches[0].spans).toHaveLength(1);
    expect(batches[0].spans[0]).toMatchObject({ progressDone: 3, progressTotal: 5, status: "partial" });
  });
  it("drops info first, then the oldest event, keeping absolute cumulative counts", async () => {
    const { recorder, settings, batches } = setup();
    settings.writer.queue_max = 3;
    await recorder.flush();
    const root = recorder.cycleRoot(1);
    root.item("item.failed", { jobId: 1 }); root.item("item.ok", { jobId: 2 }); root.item("item.paused", { jobId: 3 }); root.item("item.failed", { jobId: 4 });
    await recorder.flush();
    expect(batches[0].events.map((event) => event.jobId)).toEqual([3, 4]);
    expect(batches[0].spans[0].eventsDropped).toBe(2);
    root.note("info", "pruned", { count: "unsafe value" });
    root.finish("ok"); await recorder.flush();
    expect(batches[1].spans[0].eventsDropped).toBe(3);
  });
  it("refuses new spans without losing the state already in a full queue", async () => {
    const { recorder, settings, batches, warn } = setup();
    settings.writer.queue_max = 1;
    await recorder.flush();
    const root = recorder.cycleRoot(1);
    expect(root.child("step.collect")).toBe(noopSpan);
    root.item("item.ok"); root.finish("ok");
    expect(warn).not.toHaveBeenCalled();
    await recorder.flush();
    expect(batches[0].spans[0]).toMatchObject({ eventsDropped: 1, status: "ok" });
    expect(warn.mock.calls[0][0]).toContain("spans_dropped=1");
  });
  it("reserves room for a live handle across flushes until its terminal state is persisted", async () => {
    const { recorder, settings, batches } = setup();
    settings.writer.queue_max = 1; await recorder.flush();
    const first = recorder.cycleRoot(1); await recorder.flush();
    expect(recorder.cycleRoot(2)).toBe(noopSpan);
    first.progress(3); first.finish("ok"); await recorder.flush();
    expect(batches[1].spans).toHaveLength(1);
    expect(recorder.cycleRoot(2)).not.toBe(noopSpan);
    first.item("item.ok"); first.note("info", "pruned");
    first.item("invalid" as ItemEventCode);
    await recorder.flush(); expect(batches[2].spans).toHaveLength(1); expect(batches[2].events).toHaveLength(0);
  });
  it("caps events over a span's entire lifetime, including already flushed events", async () => {
    const { recorder, settings, batches } = setup();
    settings.capture.max_events_per_span = 2;
    await recorder.flush();
    const span = recorder.cycleRoot(1);
    span.item("item.ok"); await recorder.flush();
    span.item("item.ok"); span.item("item.ok"); span.item("item.ok"); await recorder.flush();
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(2);
    expect(batches[1].spans[0].eventsDropped).toBe(2);
  });
  it("drops invalid event params and links as whole events; sanitizes codes", async () => {
    const { recorder, batches } = setup();
    const span = recorder.cycleRoot(1);
    span.note("info", "pruned", { url: "https://example.test?secret=1" });
    span.item("item.ok", { jobId: Number.MAX_SAFE_INTEGER + 1 });
    span.item("item.failed", { errorCode: "a private error" });
    span.item("item.failed", { errorCode: "invalidPayload" });
    span.finish("failed", { reasonCode: "a private reason" });
    await recorder.flush();
    expect(batches[0].spans[0]).toMatchObject({ reasonCode: "other", eventsDropped: 3 });
    expect(batches[0].events).toHaveLength(1);
    expect(batches[0].events[0].params).toEqual({ error_code: "other" });
    expect(JSON.stringify(batches)).not.toContain("private");
    expect(recorder.systemRoot("system.backup", { channelId: "url with spaces" })).toBe(noopSpan);
  });
  it("retains event ids and newer progress across a failed in-flight write", async () => {
    const { recorder, writeBatch, settings } = setup();
    let fail!: (error: Error) => void;
    writeBatch.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    const root = recorder.cycleRoot(1);
    root.item("item.ok"); root.progress(1, 5);
    const first = recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    const id = writeBatch.mock.calls[0][1].events[0].id;
    root.progress(4, 5); root.finish("ok");
    fail(new Error("private")); await first;
    await recorder.flush(); expect(writeBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(settings.writer.retry_backoff_ms);
    await recorder.flush();
    expect(writeBatch.mock.calls[1][1].events[0].id).toBe(id);
    expect(writeBatch.mock.calls[1][1].spans[0]).toMatchObject({ status: "ok", progressDone: 4, eventsDropped: 0 });
  });
  it("accounts for in-flight capacity and never doubles dropped counts on retry", async () => {
    const { recorder, settings, writeBatch } = setup();
    settings.writer.queue_max = 2;
    await recorder.flush();
    let fail!: (error: Error) => void;
    writeBatch.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    const span = recorder.cycleRoot(1);
    span.item("item.ok");
    const first = recorder.flush(); await vi.advanceTimersByTimeAsync(0);
    span.item("item.ok"); span.item("item.ok");
    fail(new Error("private")); await first;
    await vi.advanceTimersByTimeAsync(settings.writer.retry_backoff_ms); await recorder.flush();
    expect(writeBatch.mock.calls[1][1].spans[0].eventsDropped).toBe(2);
    expect(writeBatch.mock.calls[1][1].events).toHaveLength(1);
  });
  it("coalesces concurrent flush calls, times out a hung writer, destroys and reopens its connection", async () => {
    const { recorder, settings, writeBatch, end, openConnection, warn } = setup();
    writeBatch.mockImplementationOnce(() => new Promise<void>(() => {}));
    recorder.cycleRoot(1).finish("ok");
    const first = recorder.flush(); const second = recorder.flush();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(settings.writer.flush_deadline_ms);
    await expect(first).resolves.toBeUndefined(); await second;
    expect(end).toHaveBeenCalledWith({ timeout: 0 }); expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(settings.writer.retry_backoff_ms); await recorder.flush();
    expect(openConnection).toHaveBeenCalledTimes(2);
  });
  it("throttles warnings and excludes messages, URLs and arbitrary thrown values", async () => {
    const { recorder, settings, writeBatch, warn } = setup();
    writeBatch.mockRejectedValue(Object.assign(new Error("secret=https://example.test/?token=private"), { code: "ECONNREFUSED" }));
    recorder.cycleRoot(1);
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(settings.writer.retry_backoff_ms); await recorder.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(settings.writer.warn_every_seconds * 1000); await recorder.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("ECONNREFUSED");
    expect(warn.mock.calls.flat().join("")).not.toMatch(/secret|https|private/);
  });
  it("disables new spans/events while existing handles still finish; reenables once per transition", async () => {
    const onReenable = vi.fn(() => { throw new Error("callback failed"); });
    const { recorder, settings, batches } = setup({ onReenable });
    const span = recorder.cycleRoot(1); await recorder.flush();
    settings.enabled = false; await recorder.flush();
    expect(recorder.enabled).toBe(false);
    expect(recorder.cycleRoot(2)).toBe(noopSpan); expect(span.child("step.ai")).toBe(noopSpan);
    span.item("item.ok"); span.note("info", "pruned"); span.progress(2); span.finish("ok"); await recorder.flush();
    expect(batches[1].spans[0]).toMatchObject({ status: "ok", progressDone: 2 });
    expect(batches[1].events).toHaveLength(0);
    settings.enabled = true; await recorder.flush(); await recorder.flush();
    expect(onReenable).toHaveBeenCalledTimes(1);
  });
  it("keeps the last good settings after a load failure and starts disabled on a cold failure", async () => {
    const loadSettings = vi.fn<() => ActivityLogConfig>(() => { throw new Error("private YAML"); });
    const { recorder, warn } = setup({ loadSettings });
    expect(recorder.enabled).toBe(false); expect(recorder.cycleRoot(1)).toBe(noopSpan);
    await recorder.flush(); await recorder.flush(); expect(warn).toHaveBeenCalledTimes(1);
    loadSettings.mockImplementation(() => activitySettings()); await recorder.flush();
    expect(recorder.enabled).toBe(true);
    loadSettings.mockImplementation(() => { throw new Error("private YAML"); }); await recorder.flush();
    expect(recorder.enabled).toBe(true);
  });
  it("only inserts a placeholder for attachments and keeps all children under the shared root", async () => {
    const { recorder, batches } = setup();
    const attached = recorder.attachCycle(9);
    attached.progress(9); attached.finish("failed");
    const child = attached.child("ai.score"); child.item("item.ok"); child.finish("ok");
    await recorder.flush();
    expect(batches[0].roots[0]).toMatchObject({ id: attached.id, status: "running", progressDone: null });
    expect(batches[0].spans.map((span) => span.id)).toEqual([child.id]);
  });
  it("holds deferred trees until finish, and discards their queued state and future calls", async () => {
    const { recorder, batches } = setup();
    const request = recorder.requestRoot({ id: 1, kind: "run_cycle" }, { deferred: true });
    const child = request.child("step.collect"); child.item("item.ok"); child.finish("ok");
    await recorder.flush(); expect(batches).toHaveLength(0);
    request.discard(); request.finish("failed"); child.item("item.ok");
    await recorder.flush(); expect(batches).toHaveLength(0);
    const kept = recorder.requestRoot({ id: 2, kind: "run_cycle" }, { deferred: true });
    kept.progress(1); kept.item("item.failed"); kept.finish("failed"); await recorder.flush();
    expect(batches[0].spans).toHaveLength(1); expect(batches[0].events).toHaveLength(1);
  });
  it("drops batches before migration, counts on surviving handles and later recovers", async () => {
    const { recorder, batches, writeBatch, warn } = setup();
    vi.mocked(activityTablesReady).mockResolvedValueOnce(false);
    const span = recorder.cycleRoot(1); span.item("item.ok"); await recorder.flush();
    expect(writeBatch).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    span.finish("ok"); await recorder.flush();
    expect(batches[0].spans[0].eventsDropped).toBe(1); expect(batches[0].events).toHaveLength(0);
  });
  it("bounds close even during a hung flush and stops automatic timers", async () => {
    const { recorder, settings, writeBatch, end } = setup({ autoFlush: true });
    writeBatch.mockImplementation(() => new Promise<void>(() => {}));
    recorder.cycleRoot(1);
    await vi.advanceTimersByTimeAsync(settings.writer.flush_ms);
    const close = recorder.close();
    await vi.advanceTimersByTimeAsync(settings.writer.shutdown_flush_ms);
    await expect(close).resolves.toBeUndefined();
    expect(end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(writeBatch).toHaveBeenCalledTimes(1);
  });
  it("flushes a finish queued during an earlier write before closing", async () => {
    const { recorder, writeBatch } = setup();
    let complete!: () => void;
    writeBatch.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const root = recorder.cycleRoot(1);
    const first = recorder.flush(); await vi.advanceTimersByTimeAsync(0);
    root.finish("ok"); const close = recorder.close(); complete();
    await first; await close;
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(writeBatch.mock.calls[1][1].spans[0].status).toBe("ok");
  });
  it("retries a queued finish on close during write backoff", async () => {
    const { recorder, writeBatch } = setup();
    writeBatch.mockRejectedValueOnce(new Error("private"));
    const root = recorder.cycleRoot(1);
    await recorder.flush();
    root.finish("ok");
    await recorder.flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    await recorder.close();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(writeBatch.mock.calls[1][1].spans[0]).toMatchObject({ id: root.id, status: "ok" });
  });
  it("caches settings between flushes", async () => {
    const { recorder, settings } = setup();
    settings.enabled = false;
    expect(recorder.enabled).toBe(true);
    expect(recorder.cycleRoot(1)).not.toBe(noopSpan);
    await recorder.flush(); expect(recorder.enabled).toBe(false);
  });
  it("noops for dry runs and isolates malformed calls and a broken warning sink", async () => {
    expect(createActivityRecorder({ db: null, process: "cli" })).toBe(noopRecorder);
    expect(noopRecorder.cycleRoot(1).child("step.collect")).toBe(noopSpan);
    expect(() => { noopSpan.progress(1); noopSpan.item("item.failed"); noopSpan.note("error", "pruned"); noopSpan.finish("failed"); noopSpan.discard(); }).not.toThrow();
    await noopRecorder.flush(); await noopRecorder.close();
    const { recorder, writeBatch } = setup({ warn() { throw new Error("sink"); } });
    expect(recorder.cycleRoot(NaN)).toBe(noopSpan);
    const root = recorder.cycleRoot(1); expect(() => root.progress(NaN)).not.toThrow();
    writeBatch.mockRejectedValue(new Error("private")); await expect(recorder.flush()).resolves.toBeUndefined();
  });
});
