import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { rootIdForCycle, SAFE_ERROR_CODES } from "@/lib/activity";
import type { ActivityRecorder } from "@/lib/activity/types";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { defaultRegistry } from "@/lib/channels/registry";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { withCycleLock } from "@/lib/cycle/lock";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { createConnection } from "@/lib/db/client";
import { CONTROL_REQUEST_KINDS, insertControlRequest } from "@/lib/db/repos/control-requests";
import { createCycle, finishCycle } from "@/lib/db/repos/cycles";
import { quietLogger } from "../cycle/helpers";
import { activityRows, activityText, hookRecorder, isolateHookSteps, resetHookTables } from "./activity-hook-helpers";

let connection: ReturnType<typeof createConnection>;
let activity: ActivityRecorder;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(async () => {
  await resetHookTables(connection.db);
  resetControlHandlers();
  isolateHookSteps();
  activity = hookRecorder(connection.db);
  registerFixtureChannel(defaultRegistry, { postings: [], usesQueries: false });
});
afterEach(async () => { await activity.close(); resetControlHandlers(); resetCycleSteps(); defaultRegistry.unregister("fixture"); });
afterAll(async () => { await connection.sql.end(); });

function poll(signal = new AbortController().signal) {
  return processNextControlRequest({ db: connection.db, activity, signal, logger: quietLogger });
}

/** The same real advisory-lock/session-pid setup as control.test, using gates instead of a sleep. */
async function holdLock(channelIds: string[] | null, work: (cycleId: number) => Promise<void>): Promise<void> {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const held = withCycleLock(connection.db, "try", async (holder) => {
    const cycle = await createCycle(connection.db, {
      kind: channelIds === null ? "weekday_morning" : "manual", summary: { channelIds, lockPid: holder.pid },
    });
    ready.resolve(cycle.id);
    await release.promise;
    await finishCycle(connection.db, cycle.id, { status: "succeeded" });
  });
  // If acquiring the lock fails, reject promptly instead of waiting forever for ready.
  const notReady = held.then((): never => { throw new Error("test cycle lock was not acquired"); });
  try { await work(await Promise.race([ready.promise, notReady])); }
  finally { release.resolve(); expect((await held).acquired).toBe(true); }
}

describe("control request activity persistence", () => {
  // Enumerate from the production registry so a newly registered kind automatically gets coverage.
  it.each(CONTROL_REQUEST_KINDS)("records one linked terminal request span for %s", async (kind) => {
    registerControlHandler(kind, async () => ({ status: "done", result: {} }));
    const cycle = kind === "run_ai" ? await createCycle(connection.db, { kind: "manual" }) : null;
    if (cycle) { activity.cycleRoot(cycle.id).finish("ok"); await finishCycle(connection.db, cycle.id, { status: "succeeded" }); }
    const request = await insertControlRequest(connection.db, { kind, payload: cycle ? { cycleId: cycle.id } : {} });
    expect(await poll()).toMatchObject({ id: request.id, status: "done" });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    const linked = spans.filter((s) => s.controlRequestId === request.id);
    expect(linked).toHaveLength(1);
    const span = linked[0]!;
    expect(span).toMatchObject({ name: `request.${kind}`, status: "ok" });
    expect(span.finishedAt).toBeInstanceOf(Date);
    if (cycle) expect(span).toMatchObject({ rootId: rootIdForCycle(cycle.id), parentId: rootIdForCycle(cycle.id), cycleId: cycle.id });
    else expect(span).toMatchObject({ scope: "request", parentId: null, rootId: span.id });
    expect(spans).toHaveLength(cycle ? 2 : 1);
  });

  it("records a throwing handler as failed with a safe code and no exception text", async () => {
    const message = "private handler failure SECRET123 https://x.example/?token=SECRET123";
    registerControlHandler("rescore_stale", async () => { throw new Error(message); });
    const request = await insertControlRequest(connection.db, { kind: "rescore_stale" });
    expect(await poll()).toMatchObject({ id: request.id, status: "failed", result: { error: "handler_error" } });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ controlRequestId: request.id, status: "failed", reasonCode: "handler_error" });
    expect(SAFE_ERROR_CODES).toContain(spans[0]!.reasonCode);
    const text = await activityText(connection.db);
    expect(text).not.toContain(message);
    expect(text).not.toContain("SECRET123");
  });

  it("keeps interrupted and successful attempts as distinct spans for the same requeued request", async () => {
    const abort = new AbortController();
    registerControlHandler("rescore_stale", async () => {
      abort.abort();
      throw new DOMException("private shutdown reason", "AbortError");
    });
    const request = await insertControlRequest(connection.db, { kind: "rescore_stale" });
    expect(await processNextControlRequest({ db: connection.db, activity, signal: abort.signal, logger: quietLogger, maxRequeues: () => 1 }))
      .toMatchObject({ id: request.id, status: "pending" });
    await activity.flush();
    const first = (await activityRows(connection.db)).spans;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ controlRequestId: request.id, status: "interrupted" });
    registerControlHandler("rescore_stale", async () => ({ status: "done", result: {} }));
    expect(await poll()).toMatchObject({ id: request.id, status: "done" });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((s) => s.id)).size).toBe(2);
    expect(spans.every((s) => s.controlRequestId === request.id && s.parentId === null && s.finishedAt !== null)).toBe(true);
    expect(spans.map((s) => s.status).sort()).toEqual(["interrupted", "ok"]);
    expect(spans.find((s) => s.id === first[0]!.id)).toEqual(first[0]);
  });

  it("runs the real run_cycle handler with a linked cycle root and discards the deferred request root", async () => {
    const request = await insertControlRequest(connection.db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
    const finished = await poll();
    expect(finished).toMatchObject({ id: request.id, status: "done", result: { cycleStatus: "succeeded" } });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    const roots = spans.filter((s) => s.parentId === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: "cycle", scope: "cycle", controlRequestId: request.id, status: "ok" });
    expect(finished?.result).toMatchObject({ cycleId: roots[0]!.cycleId });
    expect(roots[0]!.id).toBe(rootIdForCycle(roots[0]!.cycleId!));
    expect(spans.some((s) => s.name === "request.run_cycle")).toBe(false);
    expect(spans.filter((s) => s.name === "collect.query")).toHaveLength(1);
    expect(spans.every((s) => s.status !== "running" && s.finishedAt !== null)).toBe(true);
  });

  it("records a covered run_cycle as one skipped linked cycle with a covering-cycle note", async () => {
    await holdLock(null, async (coveringId) => {
      const request = await insertControlRequest(connection.db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
      const finished = await poll();
      expect(finished).toMatchObject({ id: request.id, status: "done", result: { cycleId: coveringId, coveredBy: coveringId } });
      await activity.flush();
      const { spans, events } = await activityRows(connection.db);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ name: "cycle", scope: "cycle", parentId: null, controlRequestId: request.id,
        status: "skipped", reasonCode: "covered_by_running_cycle" });
      expect(spans[0]!.cycleId).not.toBe(coveringId);
      expect(finished?.result).toMatchObject({ skippedCycleId: spans[0]!.cycleId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ spanId: spans[0]!.id, code: "covered_by", params: { cycle_id: coveringId } });
    });
  });

  it("records an uncovered run_cycle lock conflict as one plain skipped cycle", async () => {
    await holdLock(["other-channel"], async () => {
      const request = await insertControlRequest(connection.db, { kind: "run_cycle", payload: { channelIds: ["fixture"] } });
      expect(await poll()).toMatchObject({ id: request.id, status: "failed", result: { error: "another_cycle_running" } });
      await activity.flush();
      const { spans, events } = await activityRows(connection.db);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ name: "cycle", parentId: null, controlRequestId: request.id,
        status: "skipped", reasonCode: "another_cycle_running" });
      expect(events).toEqual([]);
    });
  });

  it("records invalid run_cycle payloads as one failed request root without a cycle", async () => {
    const request = await insertControlRequest(connection.db, { kind: "run_cycle", payload: { channelIds: "private input" } });
    expect(await poll()).toMatchObject({ status: "failed", result: { error: "invalid_payload" } });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "request.run_cycle", scope: "request", parentId: null,
      controlRequestId: request.id, cycleId: null, status: "failed", reasonCode: "invalid_payload" });
    expect(spans[0]!.finishedAt).toBeInstanceOf(Date);
    expect(await activityText(connection.db)).not.toContain("private input");
  });

  it("creates no activity rows for an empty poll", async () => {
    expect(await poll()).toBeNull();
    await activity.flush();
    expect(await activityRows(connection.db)).toEqual({ spans: [], events: [] });
  });
});
