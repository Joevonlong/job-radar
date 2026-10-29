import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createConnection } from "@/lib/db/client";
import { getActivityRoot, listActivityEvents, listActivityRoots, listQueryRows } from "@/lib/db/queries/activity";
import { writeActivityBatch } from "@/lib/db/repos/activity";
import { activityEvents, activitySpans, controlRequests, cycles, runDeliveries, runnerHeartbeats } from "@/lib/db/schema";
import { activityEvent, activityRow, liveness } from "./activity-helpers";
import { seedActivityReadFixture, READ_AT } from "./activity-read-helpers";
import { resetHookTables } from "./activity-hook-helpers";

let connection: ReturnType<typeof createConnection>;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(async () => { await resetHookTables(connection.db); });
afterAll(async () => { await connection.sql.end(); });
const page = { page: 1, pageSize: 20 };

describe("activity read queries", () => {
  it("sorts active roots first, returns totals and applies each filter before paging", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    const older = new Date(READ_AT.getTime() - 1000);
    const system = activityRow({ status: "partial", startedAt: new Date(READ_AT.getTime() + 2000), eventsDropped: 1 });
    const failed = activityRow({ status: "ok", startedAt: older });
    const child = activityRow({ rootId: failed.id, parentId: failed.id, status: "failed", name: "ai.score" });
    await writeActivityBatch(db, { roots: [system, failed], spans: [system, failed, child], events: [], batchSize: 5 });
    const all = await listActivityRoots(db, {}, page, liveness);
    expect(all.total).toBe(5); expect(all.anyActive).toBe(true);
    expect(all.rows.map((r) => r.id)).toEqual([fixture.root.id, system.id, fixture.attempt2.id, fixture.attempt1.id, failed.id]);
    expect(all.rows[0]).toMatchObject({ runAi: { status: "pending" }, eventsDropped: 3, warnEvents: 1, errorEvents: 1, active: true });
    expect((await listActivityRoots(db, { status: "active" }, page, liveness)).rows.map((r) => r.id)).toEqual([fixture.root.id]);
    expect((await listActivityRoots(db, { scope: "request" }, page, liveness)).total).toBe(2);
    expect((await listActivityRoots(db, { status: "failed" }, page, liveness)).rows.map((r) => r.id)).toEqual([fixture.attempt1.id, failed.id]);
    expect((await listActivityRoots(db, { status: "partial" }, page, liveness)).rows.map((r) => r.id)).toEqual([system.id]);
    expect((await listActivityRoots(db, { issuesOnly: true }, page, liveness)).total).toBe(3);
    expect((await listActivityRoots(db, { from: READ_AT, to: new Date(READ_AT.getTime() + 1) }, page, liveness)).total).toBe(2);
    const emptyPage = await listActivityRoots(db, {}, { page: 9, pageSize: 1 }, liveness);
    expect(emptyPage).toEqual({ rows: [], total: 5, anyActive: true });
  });
  it("selects the newest running subtask only under the current running step", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    await db.update(activitySpans).set({ status: "running", progressDone: 2, progressTotal: 5 }).where(eq(activitySpans.id, fixture.step.id));
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.root.currentSubtask).toBeNull();
    const delegated = activityRow({ rootId: fixture.root.id, parentId: fixture.root.id, scope: "cycle", name: "request.run_ai", status: "running", startedAt: new Date(READ_AT.getTime() + 99) });
    const scoreStep = activityRow({ rootId: fixture.root.id, parentId: delegated.id, scope: "cycle", name: "step.ai", status: "running", startedAt: new Date(READ_AT.getTime() + 100) });
    const old = activityRow({ rootId: fixture.root.id, parentId: fixture.step.id, scope: "cycle", name: "collect.query", status: "running", startedAt: new Date(READ_AT.getTime() + 500) });
    const subtask = activityRow({ rootId: fixture.root.id, parentId: scoreStep.id, scope: "cycle", name: "ai.score", status: "running", progressDone: 3, progressTotal: 9, startedAt: new Date(READ_AT.getTime() + 101) });
    const previousSubtask = activityRow({ ...subtask, id: activityRow().id, name: "ai.signals", progressDone: 1, startedAt: new Date(READ_AT.getTime() + 100) });
    const finished = activityRow({ ...subtask, id: activityRow().id, status: "ok", startedAt: new Date(READ_AT.getTime() + 200) });
    await db.insert(activitySpans).values([delegated, scoreStep, old, previousSubtask, subtask, finished]);
    const root = (await getActivityRoot(db, fixture.root.id, liveness))!.root;
    expect(root.currentStep?.name).toBe("step.ai");
    expect(root.currentSubtask).toEqual({ name: "ai.score", progressDone: 3, progressTotal: 9 });
    const list = await listActivityRoots(db, { scope: "cycle", from: READ_AT, to: new Date(READ_AT.getTime() + 1) }, page, liveness);
    expect(list.total).toBe(1);
    expect(list.rows[0].currentSubtask).toEqual(root.currentSubtask);
    expect((await listActivityRoots(db, { scope: "system", from: READ_AT, to: new Date(READ_AT.getTime() + 1) }, page, liveness)).total).toBe(0);
    await db.update(activitySpans).set({ status: "ok" }).where(eq(activitySpans.id, scoreStep.id));
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.root).toMatchObject({ currentStep: { name: "step.collect", progressDone: 2, progressTotal: 5 }, currentSubtask: { name: "collect.query" } });
  });
  it("marks the latest request root current without counting a child as a competing attempt", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    const child = activityRow({ rootId: fixture.attempt1.id, parentId: fixture.attempt1.id, scope: "request", name: "ai.translate", controlRequestId: fixture.request.id, startedAt: new Date(READ_AT.getTime() + 10) });
    await db.insert(activitySpans).values(child);
    const rows = (await listActivityRoots(db, { scope: "request" }, page, liveness)).rows;
    expect(rows.map((r) => [r.id, r.status, r.isCurrentAttempt])).toEqual([[fixture.attempt2.id, "ok", true], [fixture.attempt1.id, "interrupted", false]]);
    expect(rows[0].request).toEqual({ kind: "translate_job", status: "done", errorCode: "other" });
    const detail = await getActivityRoot(db, fixture.attempt1.id, liveness);
    expect(detail?.attempts.map((a) => [a.id, a.status, a.isCurrent])).toEqual([[fixture.attempt1.id, "interrupted", false], [fixture.attempt2.id, "ok", true]]);
  });
  it("keeps the current status attached to each distinct delegated request", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "failed" }).where(eq(controlRequests.id, fixture.ai.id));
    const [next] = await db.insert(controlRequests).values({ kind: "run_ai", payload: { cycleId: fixture.cycle.id }, status: "pending", requestedAt: new Date(READ_AT.getTime() + 100) }).returning();
    const old = activityRow({ rootId: fixture.root.id, parentId: fixture.root.id, scope: "cycle", name: "request.run_ai", controlRequestId: fixture.ai.id, status: "failed", startedAt: READ_AT });
    const recent = activityRow({ rootId: fixture.root.id, parentId: fixture.root.id, scope: "cycle", name: "request.run_ai", controlRequestId: next.id, status: "interrupted", startedAt: new Date(READ_AT.getTime() + 100) });
    await db.insert(activitySpans).values([old, recent]);
    const detail = await getActivityRoot(db, fixture.root.id, liveness);
    expect(detail?.root.runAi).toEqual({ status: "pending" });
    expect(detail?.attempts.map((a) => [a.id, a.status, a.isCurrent, a.requestCurrent])).toEqual([[old.id, "failed", true, "failed"], [recent.id, "interrupted", true, "pending"]]);
  });
  it("uses id descending to break equal-time attempt ties", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    await db.update(activitySpans).set({ startedAt: READ_AT }).where(eq(activitySpans.id, fixture.attempt2.id));
    const rows = (await listActivityRoots(db, { scope: "request" }, page, liveness)).rows;
    expect(rows.map((r) => r.id)).toEqual([fixture.attempt1.id, fixture.attempt2.id].sort().reverse());
    expect(rows.map((r) => r.isCurrentAttempt)).toEqual([true, false]);
  });
  it("projects the entire tree, step durations and run_ai attempts with safe compatibility values", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    const a = activityRow({ rootId: fixture.root.id, parentId: fixture.root.id, scope: "cycle", name: "request.run_ai", controlRequestId: fixture.ai.id, status: "interrupted", startedAt: READ_AT });
    const b = activityRow({ ...a, id: activityRow().id, status: "running", startedAt: new Date(READ_AT.getTime() + 5) });
    await db.insert(activitySpans).values([a, b]);
    const detail = await getActivityRoot(db, fixture.root.id, liveness);
    expect(detail?.spans).toHaveLength(7);
    expect(detail?.root.currentStep).toBeNull();
    expect(detail?.stepDurations).toEqual([{ name: "step.collect", status: "ok", durationMs: 12 }]);
    expect(detail?.attempts.map((s) => [s.id, s.isCurrent])).toEqual([[a.id, false], [b.id, true]]);
    expect(detail?.spans.find((s) => s.id === fixture.queries[0].id)?.eventCounts).toEqual({ info: 1, warn: 1, error: 0 });
    await db.update(activitySpans).set({ name: "future.private", status: "future_status", reasonCode: "private reason" }).where(eq(activitySpans.id, fixture.root.id));
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.root).toMatchObject({ name: "unknown", status: "unknown", reasonCode: "other" });
    await db.update(cycles).set({ summaryJson: null }).where(eq(cycles.id, fixture.cycle.id));
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.stepDurations).toBeNull();
    await db.delete(cycles).where(eq(cycles.id, fixture.cycle.id));
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.stepDurations).toBeNull();
    expect(await getActivityRoot(db, activityRow().id, liveness)).toBeNull();
  });
  it("keeps all cascade-skipped query rows, safely joins runs and validates delivery counters", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    const result = await listQueryRows(db, fixture.root.id);
    expect(result.queriesNotReached).toBe(5); expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ run: { status: "partial", fetched: 7, newCount: 3, costUsd: 0.125, errorCode: "other" },
      delivery: { delivered: 7, billedUnits: 9, stored: 3, dispositions: { stored: 3, outside_window: 2, no_identity: 2 } }, cascadeReasons: { fixture: "budget_exceeded", second: "circuit_open" } });
    expect(result.rows.slice(1).map((r) => r.run)).toEqual([null, null]);
    await db.update(activitySpans).set({ runId: fixture.runWithoutDelivery.id }).where(eq(activitySpans.id, fixture.queries[1].id));
    expect((await listQueryRows(db, fixture.root.id)).rows[1]).toMatchObject({ run: { fetched: 2 }, delivery: null });
    await db.update(runDeliveries).set({ countsJson: { dispositions: { private: 5 }, flags: {} } });
    expect((await listQueryRows(db, fixture.root.id)).rows[0].delivery).toBeNull();
    await db.update(runDeliveries).set({ countsJson: { dispositions: { no_identity: 7 }, flags: {} } });
    expect((await listQueryRows(db, fixture.root.id)).rows[0].delivery?.stored).toBe(0);
    expect(await listQueryRows(db, fixture.attempt1.id)).toEqual({ rows: [], queriesNotReached: null });
  });
  it("paginates and filters events, preserves missing-job links and validates every scalar", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    const event = activityEvent(fixture.root);
    await db.insert(activityEvents).values({ ...event, level: "future", code: "future", params: {
      error_code: "sk-test-SECRET123", valid: "a:b.c-d_1", numeric: 1.5, truth: false, url: "https://example.test/?private", object: { private: true }, long: "a".repeat(65), "invalid key": 2,
    } });
    const all = await listActivityEvents(db, fixture.root.id, page);
    expect(all.total).toBe(6);
    expect(all.rows.find((e) => e.id === event.id)).toMatchObject({ level: "unknown", code: "unknown", params: { error_code: "other", valid: "a:b.c-d_1", numeric: 1.5, truth: false }, job: null });
    const warn = await listActivityEvents(db, fixture.root.id, { ...page, level: "warn", spanId: fixture.queries[0].id });
    expect(warn.total).toBe(1); expect(warn.rows[0].job).toEqual({ exists: true, title: "Engineer", company: "Example" });
    expect((await listActivityEvents(db, fixture.root.id, { ...page, level: "error" })).rows[0].job).toEqual({ exists: false, title: null, company: null });
    expect((await listActivityEvents(db, fixture.root.id, { page: 2, pageSize: 4 })).rows).toHaveLength(2);
    expect((await listActivityEvents(db, fixture.root.id, { page: 3, pageSize: 4 })).total).toBe(6);
  });
  it("observes process liveness using DB time, including a heartbeat preceding the root", async () => {
    const db = connection.db;
    const [{ at }] = await db.select({ at: sql<string>`now()` }).from(sql`(values(1)) as clock(value)`);
    const now = new Date(at);
    const root = activityRow({ startedAt: new Date(now.getTime() - 5000) });
    await db.insert(activitySpans).values(root);
    await db.insert(runnerHeartbeats).values({ process: "runner", at: new Date(now.getTime() - 10_000) });
    expect((await getActivityRoot(db, root.id, liveness))?.root).toMatchObject({ active: true, newerStartup: false });
    await db.update(runnerHeartbeats).set({ at: new Date(now.getTime() - 61_000) });
    expect((await getActivityRoot(db, root.id, liveness))?.root.active).toBe(false);
    await db.delete(runnerHeartbeats);
    expect((await getActivityRoot(db, root.id, liveness))?.root.active).toBe(true);
    await db.update(activitySpans).set({ startedAt: new Date(now.getTime() - 31_000) }).where(eq(activitySpans.id, root.id));
    expect((await getActivityRoot(db, root.id, liveness))?.root.active).toBe(false);
    await db.insert(runnerHeartbeats).values({ process: "runner", at: now });
    await db.insert(activitySpans).values(activityRow({ name: "system.startup", status: "ok", startedAt: now }));
    expect((await getActivityRoot(db, root.id, liveness))?.root).toMatchObject({ active: false, newerStartup: true });
  });
  it("takes the latest run_ai request rather than an older pending one", async () => {
    const db = connection.db;
    const fixture = await seedActivityReadFixture(db);
    await db.insert(controlRequests).values({ kind: "run_ai", payload: { cycleId: fixture.cycle.id }, status: "done", requestedAt: new Date(READ_AT.getTime() + 100) });
    expect((await getActivityRoot(db, fixture.root.id, liveness))?.root.runAi).toEqual({ status: "done" });
  });
});
