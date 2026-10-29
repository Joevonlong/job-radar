import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { pruneActivityLog, reconcileActivity } from "@/lib/activity/maintenance";
import type { ActivitySpanWrite } from "@/lib/activity/types";
import { createConnection } from "@/lib/db/client";
import { activeRootCondition, pruneActivity, pruneActivityBatch, reconcileActivitySpans, resetActivityTablesCache, writeActivityBatch } from "@/lib/db/repos/activity";
import { countTableRows } from "@/lib/db/repos/table-counts";
import { getDbNow } from "@/lib/db/repos/cycles";
import { getAiUsageGroups } from "@/lib/db/queries/ai-usage";
import { withTimeout } from "@/lib/ops/timeout";
import { activityEvents, activitySpans, aiUsage, channels, controlRequests, cycles, rawPostings, runnerHeartbeats, runs } from "@/lib/db/schema";
import { activityEvent, activityRow, integrationActivitySettings, liveness } from "./activity-helpers";

let connection: ReturnType<typeof createConnection>;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(() => resetActivityTablesCache());
afterAll(async () => { await connection.sql.end(); });
const write = (rows: ActivitySpanWrite[], eventCount = 0) => writeActivityBatch(connection.db, {
  roots: rows.filter((row) => row.parentId === null), spans: rows,
  events: rows.flatMap((row) => Array.from({ length: eventCount }, () => activityEvent(row))), batchSize: 2,
});
async function dbNow(): Promise<Date> {
  return getDbNow(connection.db);
}
async function active(id: string): Promise<boolean> {
  const [row] = await connection.db.select({ active: activeRootCondition(activitySpans, liveness) }).from(activitySpans).where(eq(activitySpans.id, id));
  return row.active;
}

describe("activity reconciliation", () => {
  it.each(["pending", "running"] as const)("protects only the current %s AI attempt subtree of a finished cycle", async (status) => {
    const [finished, running] = await connection.db.insert(cycles).values([{ kind: "manual", status: "succeeded" }, { kind: "manual", status: "running" }]).returning();
    const root = activityRow({ scope: "cycle", name: "cycle", cycleId: finished.id });
    const runningRoot = activityRow({ scope: "cycle", name: "cycle", cycleId: running.id });
    const collect = activityRow({ rootId: root.id, parentId: root.id, scope: "cycle", name: "step.collect" });
    const [request] = await connection.db.insert(controlRequests).values({ kind: "run_ai", payload: { cycleId: finished.id }, status }).returning();
    // Equal start times exercise the same id tie-break as request roots. Descendants carry no request link.
    const at = await dbNow();
    const [old, live] = [0, 1].map(() => activityRow({ rootId: root.id, parentId: root.id, scope: "cycle", name: "request.run_ai", controlRequestId: request.id, startedAt: at })).sort((a, b) => a.id.localeCompare(b.id));
    const oldStep = activityRow({ rootId: root.id, parentId: old.id, scope: "cycle", name: "step.ai" });
    const liveStep = activityRow({ rootId: root.id, parentId: live.id, scope: "cycle", name: "step.ai" });
    const liveTask = activityRow({ rootId: root.id, parentId: liveStep.id, scope: "cycle", name: "ai.score" });
    const runningStep = activityRow({ rootId: runningRoot.id, parentId: runningRoot.id, scope: "cycle", name: "step.collect" });
    await write([root, collect, old, oldStep, live, liveStep, liveTask, runningRoot, runningStep]);
    await writeActivityBatch(connection.db, { roots: [], spans: [], events: [activityEvent(root)], batchSize: 2 });
    expect(await active(root.id)).toBe(true);
    expect(await reconcileActivitySpans(connection.db, liveness)).toBe(4);
    const rows = await connection.db.select().from(activitySpans);
    for (const span of [root, collect, old, oldStep]) expect(rows.find((row) => row.id === span.id)).toMatchObject({ status: "interrupted", reasonCode: "not_recorded" });
    for (const span of [live, liveStep, liveTask, runningRoot, runningStep]) expect(rows.find((row) => row.id === span.id)).toMatchObject({ status: "running", reasonCode: null });
    expect(await active(root.id)).toBe(true);
    // Retention still protects the entire root, even after its stale spans were reconciled.
    expect(await pruneActivity(connection.db, { days: 1, maxEvents: 0, batchSize: 2, liveness })).toEqual({ roots: 0, events: 0 });
    expect(await connection.db.select().from(activitySpans)).toHaveLength(rows.length);
    await connection.db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, request.id));
    expect(await reconcileActivitySpans(connection.db, liveness)).toBe(3);
  });
  it("recognizes numeric and string cycle ids without casting untrusted payloads", async () => {
    const [cycle] = await connection.db.insert(cycles).values({ kind: "manual", status: "succeeded" }).returning();
    const root = activityRow({ scope: "cycle", name: "cycle", cycleId: cycle.id }); await write([root]);
    const [request] = await connection.db.insert(controlRequests).values({ kind: "run_ai", payload: { cycleId: String(cycle.id) } }).returning();
    expect(await active(root.id)).toBe(true);
    await connection.db.update(controlRequests).set({ payload: { cycleId: "invalid text" } }).where(eq(controlRequests.id, request.id));
    expect(await active(root.id)).toBe(false);
  });
  it("protects only the newest request attempt, including ties broken by id", async () => {
    const [request] = await connection.db.insert(controlRequests).values({ kind: "translate_job" }).returning();
    const at = await dbNow();
    const roots = [activityRow({ scope: "request", name: "request.translate_job", controlRequestId: request.id, startedAt: at }), activityRow({ scope: "request", name: "request.translate_job", controlRequestId: request.id, startedAt: at })].sort((a, b) => a.id.localeCompare(b.id));
    await write(roots);
    expect(await active(roots[0].id)).toBe(false); expect(await active(roots[1].id)).toBe(true);
    expect(await reconcileActivitySpans(connection.db, liveness)).toBe(1);
    expect((await connection.db.select().from(activitySpans).where(eq(activitySpans.id, roots[0].id)))[0]).toMatchObject({ status: "interrupted", reasonCode: "not_recorded" });
  });
  it("reconciles and prunes after disabling mid-run and reenabling the same recorder", async () => {
    const settings = integrationActivitySettings();
    const [cycle] = await connection.db.insert(cycles).values({ kind: "manual" }).returning();
    const at = new Date((await dbNow()).getTime() - 4 * 86_400_000);
    let reenabling: Promise<void> | undefined;
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, now: () => at, loadSettings: () => settings,
      onReenable: () => { reenabling = reconcileActivity(recorder); },
    });
    try {
      const root = recorder.cycleRoot(cycle.id); root.child("step.ai"); await recorder.flush();
      settings.enabled = false; await recorder.flush();
      await connection.db.update(cycles).set({ status: "succeeded", finishedAt: new Date() }).where(eq(cycles.id, cycle.id));
      root.finish("ok"); await recorder.flush();
      settings.enabled = true; await recorder.flush(); await reenabling;
      expect(await active(root.id)).toBe(false);
      expect((await connection.db.select().from(activitySpans).where(eq(activitySpans.parentId, root.id)))[0]).toMatchObject({ status: "interrupted", reasonCode: "not_recorded" });
      await pruneActivity(connection.db, { days: 1, maxEvents: 100, batchSize: 2, liveness });
      expect(await connection.db.select().from(activitySpans).where(eq(activitySpans.id, root.id))).toHaveLength(0);
    } finally { await recorder.close(); }
  });
});

describe("system root liveness uses database time", () => {
  it("protects a task started between two heartbeats", async () => {
    const at = await dbNow();
    const root = activityRow({ startedAt: new Date(at.getTime() - 5000) }); await write([root]);
    await connection.db.insert(runnerHeartbeats).values({ process: "runner", at: new Date(at.getTime() - 10_000) });
    expect(await active(root.id)).toBe(true);
    expect(await reconcileActivitySpans(connection.db, liveness)).toBe(0);
    expect(await pruneActivity(connection.db, { days: 1, maxEvents: 1, batchSize: 1, liveness })).toEqual({ roots: 0, events: 0 });
  });
  it("interrupts a task whose post-start heartbeat later became stale", async () => {
    const at = await dbNow();
    const root = activityRow({ startedAt: new Date(at.getTime() - 120_000) }); await write([root]);
    await connection.db.insert(runnerHeartbeats).values({ process: "runner", at: new Date(at.getTime() - 90_000) });
    expect(await active(root.id)).toBe(false); expect(await reconcileActivitySpans(connection.db, liveness)).toBe(1);
    expect((await connection.db.select().from(activitySpans))[0].reasonCode).toBe("not_recorded");
  });
  it("uses the newest heartbeat and rejects a root from before a later process startup", async () => {
    const at = await dbNow();
    const root = activityRow({ startedAt: new Date(at.getTime() - 5000) }); await write([root]);
    await connection.db.insert(runnerHeartbeats).values([{ process: "runner", at: new Date(at.getTime() - 90_000) }, { process: "runner", at }]);
    expect(await active(root.id)).toBe(true);
    await write([activityRow({ name: "system.startup", startedAt: at, status: "ok" })]);
    expect(await active(root.id)).toBe(false); expect(await reconcileActivitySpans(connection.db, liveness)).toBe(1);
  });
  it("uses startup grace only when this process has no heartbeat rows", async () => {
    const at = await dbNow();
    const inside = activityRow({ startedAt: new Date(at.getTime() - 5000) });
    const outside = activityRow({ startedAt: new Date(at.getTime() - 45_000) });
    await write([inside, outside]);
    await connection.db.insert(runnerHeartbeats).values({ process: "ai-worker", at });
    expect(await active(inside.id)).toBe(true); expect(await active(outside.id)).toBe(false);
    expect(await reconcileActivitySpans(connection.db, liveness)).toBe(1);
  });
});

describe("activity retention", () => {
  it.each(["days", "events"] as const)("bounds child-span deletion per deadline while finishing a large tree selected by %s", async (phase) => {
    const settings = integrationActivitySettings();
    const batchSize = 3;
    const at = await dbNow();
    const root = activityRow({ status: "ok", lastActivityAt: phase === "days" ? new Date(at.getTime() - 3 * 86_400_000) : at });
    const children: ActivitySpanWrite[] = [];
    for (let i = 0; i < batchSize * 5; i++) children.push(activityRow({ rootId: root.id, parentId: children.at(-1)?.id ?? root.id, lastActivityAt: root.lastActivityAt }));
    await write([root, ...children]);
    await writeActivityBatch(connection.db, { roots: [], spans: [], events: [activityEvent(root)], batchSize });
    let previous = children.length + 2; // spans, root and one event
    let batches = 0;
    const deleted = await pruneActivity(connection.db, { days: 1, maxEvents: 0, batchSize, liveness,
      deadlineForBatch: async (work) => {
        const batch = await withTimeout(work(), settings.writer.flush_deadline_ms, "test prune batch");
        if (!batch.found) return batch;
        batches++;
        const spans = await connection.db.select().from(activitySpans);
        const events = await connection.db.select().from(activityEvents);
        const remaining = spans.length + events.length;
        expect(previous - remaining).toBeGreaterThan(0);
        expect(previous - remaining).toBeLessThanOrEqual(batchSize);
        if (spans.length) expect(spans.some((span) => span.id === root.id)).toBe(true);
        previous = remaining;
        return batch;
      },
    });
    expect(deleted).toEqual({ roots: 1, events: 1 });
    expect(batches).toBeGreaterThan(1);
    expect(previous).toBe(0);
  });
  it("deletes old inactive trees in event-sized batches and leaves every business table unchanged", async () => {
    const at = await dbNow();
    await connection.db.insert(channels).values({ id: "fixture", family: "fixture", kind: "fixture" });
    const [cycle] = await connection.db.insert(cycles).values({ kind: "manual", status: "succeeded" }).returning();
    const [run] = await connection.db.insert(runs).values({ channelId: "fixture", cycleId: cycle.id }).returning();
    await connection.db.insert(rawPostings).values({ channelId: "fixture", externalId: "fixture-1", payloadJson: { sample: true }, runId: run.id });
    await connection.db.insert(aiUsage).values({ provider: "anthropic", task: "score", tokensIn: 4, tokensOut: 2, costEstimate: 1 });
    await connection.db.insert(controlRequests).values({ kind: "test_ai", status: "done" });
    const counts = () => countTableRows(connection.db).then((rows) => rows.filter((row) => !row.table.startsWith("public.activity_")));
    const before = await counts();
    const usageOptions = { from: new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10), to: new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10), timeZone: "UTC" };
    const usageBefore = await getAiUsageGroups(connection.db, usageOptions, ["anthropic"]);
    const root = activityRow({ scope: "cycle", name: "cycle", cycleId: cycle.id, lastActivityAt: new Date(at.getTime() - 3 * 86_400_000) });
    const child = activityRow({ rootId: root.id, parentId: root.id, lastActivityAt: root.lastActivityAt });
    await write([root, child], 3);
    const options = { days: 1, maxEvents: 100, batchSize: 2, liveness, phase: "days" as const };
    const first = await pruneActivityBatch(connection.db, options);
    expect(first).toMatchObject({ roots: 0, events: 2, nextRootId: root.id });
    const rest = await pruneActivity(connection.db, options);
    expect(rest).toEqual({ roots: 1, events: 4 });
    expect(await counts()).toEqual(before); expect(await getAiUsageGroups(connection.db, usageOptions, ["anthropic"])).toEqual(usageBefore);
  });
  it("enforces max events oldest-first, finishes large trees and skips active roots", async () => {
    const at = await dbNow();
    const [cycle] = await connection.db.insert(cycles).values({ kind: "manual" }).returning();
    const activeRoot = activityRow({ scope: "cycle", name: "cycle", cycleId: cycle.id, lastActivityAt: new Date(at.getTime() - 5 * 86_400_000) });
    const oldest = activityRow({ status: "ok", lastActivityAt: new Date(at.getTime() - 2000) });
    const recent = activityRow({ status: "ok", lastActivityAt: new Date(at.getTime() - 1000) });
    await write([activeRoot, oldest, recent], 3);
    const batches: number[] = [];
    const deleted = await pruneActivity(connection.db, { days: 1, maxEvents: 7, batchSize: 2, liveness,
      deadlineForBatch: async (work) => { const batch = await work(); batches.push(batch.events); return batch; },
    });
    expect(deleted).toEqual({ roots: 1, events: 3 }); expect(batches.every((count) => count <= 2)).toBe(true);
    expect((await connection.db.select().from(activitySpans)).map((row) => row.id).sort()).toEqual([activeRoot.id, recent.id].sort());
  });
  it("records prune and reconcile summaries only when they changed rows", async () => {
    const settings = integrationActivitySettings();
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings });
    try {
      await reconcileActivity(recorder); await pruneActivityLog(recorder); await recorder.flush();
      expect(await connection.db.select().from(activitySpans)).toHaveLength(0);
      const old = new Date((await dbNow()).getTime() - 4 * 86_400_000);
      await write([activityRow({ startedAt: old, lastActivityAt: old })], 3);
      await reconcileActivity(recorder); await recorder.flush();
      expect(await connection.db.select().from(activitySpans).where(eq(activitySpans.name, "system.reconcile"))).toHaveLength(1);
      await pruneActivityLog(recorder); await recorder.flush();
      expect(await connection.db.select().from(activitySpans).where(eq(activitySpans.name, "system.prune"))).toHaveLength(1);
      const [event] = await connection.db.select().from(activityEvents).where(eq(activityEvents.code, "pruned"));
      expect(event.params).toEqual({ roots: 1, events: 3 });
      await pruneActivityLog(recorder); await recorder.flush();
      expect(await connection.db.select().from(activitySpans).where(eq(activitySpans.name, "system.prune"))).toHaveLength(1);
    } finally { await recorder.close(); }
  });
});
