import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { executeDelete, previewDelete } from "@/lib/activity/manage";
import { createConnection } from "@/lib/db/client";
import { getActivityRoot, listActivityEvents, listActivityRoots, listQueryRows, previewActivityDelete } from "@/lib/db/queries/activity";
import { getAiUsageGroups } from "@/lib/db/queries/ai-usage";
import { activityTablesReady, deleteActivityBatch, resetActivityTablesCache, writeActivityBatch, type ActivityDeleteScope } from "@/lib/db/repos/activity";
import { activityEvents, activitySpans, controlRequests, cycles, runnerHeartbeats } from "@/lib/db/schema";
import { activitySettings } from "../activity/helpers";
import { activityEvent, activityRow, liveness } from "./activity-helpers";
import { resetHookTables } from "./activity-hook-helpers";
import { PRIVATE_SAMPLES, READ_AT, seedActivityReadFixture } from "./activity-read-helpers";

vi.mock("@/lib/config", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/config")>(), loadConfig: vi.fn() }));
import { loadConfig } from "@/lib/config";
let connection: ReturnType<typeof createConnection>;
let settings: ReturnType<typeof activitySettings>;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(async () => {
  await resetHookTables(connection.db);
  settings = activitySettings();
  settings.prune.batch_size = 1;
  settings.ui.delete_budget_ms = 10_000;
  vi.mocked(loadConfig).mockImplementation(((name: string) => name === "activityLog" ? settings : { timezone: "UTC" }) as typeof loadConfig);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await connection.sql.end(); });

async function deleteAllBatches(scope: ActivityDeleteScope, asOf: Date) {
  const result = { roots: 0, events: 0 };
  for (let count = 0; count < 100; count++) {
    const before = await activityCount();
    const batch = await deleteActivityBatch(connection.db, { scope, asOf, liveness, batchSize: 1, rootsPerBatch: 1 });
    const after = await activityCount();
    expect(before - after).toBeLessThanOrEqual(1);
    result.roots += batch.roots; result.events += batch.events;
    if (!batch.found) return result;
  }
  throw new Error("delete did not converge");
}
async function activityCount() {
  const [row] = await connection.db.execute<{ count: number }>(sql`select ((select count(*) from activity_spans)+(select count(*) from activity_events))::integer as count`);
  return row.count;
}
async function businessCounts() {
  const [row] = await connection.db.execute<Record<string, number>>(sql`select
    (select count(*)::integer from cycles) as cycles, (select count(*)::integer from runs) as runs,
    (select count(*)::integer from raw_postings) as raw_postings, (select count(*)::integer from ai_usage) as ai_usage,
    (select count(*)::integer from control_requests) as control_requests, (select count(*)::integer from run_deliveries) as run_deliveries,
    (select count(*)::integer from delivery_items) as delivery_items`);
  return row;
}
const usageFilter = { from: "2026-10-01", to: "2026-10-31", timeZone: "UTC" };

describe("activity deletion", () => {
  it("previews precisely the completed tree, counts active roots and respects asOf", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    const preview = await previewActivityDelete(db, { kind: "all" }, liveness);
    expect(preview).toMatchObject({ roots: 2, events: 0, skippedActive: 1 });
    const late = activityRow({ status: "ok", startedAt: new Date(preview.asOf.getTime() + 1) });
    await db.insert(activitySpans).values(late);
    expect(await deleteAllBatches({ kind: "all" }, preview.asOf)).toEqual({ roots: preview.roots, events: preview.events });
    expect(await getActivityRoot(db, late.id, liveness)).not.toBeNull();
    expect(await getActivityRoot(db, f.root.id, liveness)).not.toBeNull();
  });
  it.each(["root", "range", "all"] as const)("preview equals execution for %s scope, even at batch size one", async (kind) => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, f.ai.id));
    const scope: ActivityDeleteScope = kind === "root" ? { kind, rootId: f.root.id } : kind === "range"
      ? { kind, from: READ_AT, to: new Date(READ_AT.getTime() + 1) } : { kind };
    const preview = await previewActivityDelete(db, scope, liveness);
    expect(preview.roots).toBe(kind === "root" ? 1 : kind === "range" ? 2 : 3);
    expect(preview.events).toBe(5); expect(preview.skippedActive).toBe(0);
    expect(await deleteAllBatches(scope, preview.asOf)).toEqual({ roots: preview.roots, events: preview.events });
    expect((await previewActivityDelete(db, scope, liveness)).roots).toBe(0);
  });
  it("handles range's optional from, exclusive to and top-level roots only", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, f.ai.id));
    expect(await previewActivityDelete(db, { kind: "range", from: null, to: READ_AT }, liveness)).toMatchObject({ roots: 0, events: 0 });
    expect(await previewActivityDelete(db, { kind: "root", rootId: f.step.id }, liveness)).toMatchObject({ roots: 0, events: 0 });
    expect(await deleteAllBatches({ kind: "root", rootId: f.step.id }, new Date())).toEqual({ roots: 0, events: 0 });
  });
  it("protects a running cycle, the current pending request attempt and a system with fresh heartbeat", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "pending" }).where(eq(controlRequests.id, f.request.id));
    const [cycle] = await db.insert(cycles).values({ kind: "manual", status: "running" }).returning();
    const activeCycle = activityRow({ scope: "cycle", name: "cycle", cycleId: cycle.id, startedAt: READ_AT });
    const activeSystem = activityRow({ startedAt: READ_AT });
    await db.insert(activitySpans).values([activeCycle, activeSystem]);
    await db.insert(runnerHeartbeats).values({ process: "runner" });
    const preview = await previewActivityDelete(db, { kind: "all" }, liveness);
    expect(preview).toMatchObject({ roots: 1, events: 0, skippedActive: 4 });
    expect(await deleteAllBatches({ kind: "all" }, preview.asOf)).toEqual({ roots: 1, events: 0 });
    expect(await getActivityRoot(db, f.attempt1.id, liveness)).toBeNull();
    for (const id of [activeCycle.id, activeSystem.id, f.attempt2.id, f.root.id]) expect(await getActivityRoot(db, id, liveness)).not.toBeNull();
  });
  it("rechecks liveness at execution if a previewed request becomes active", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    const scope = { kind: "root", rootId: f.attempt2.id } as const;
    const preview = await previewActivityDelete(db, scope, liveness);
    expect(preview.roots).toBe(1);
    await db.update(controlRequests).set({ status: "pending" }).where(eq(controlRequests.id, f.request.id));
    expect(await deleteAllBatches(scope, preview.asOf)).toEqual({ roots: 0, events: 0 });
  });
  it("spends the row budget on events, children and then the root in that order", async () => {
    const db = connection.db;
    const root = activityRow({ status: "ok", startedAt: READ_AT });
    const child = activityRow({ rootId: root.id, parentId: root.id });
    await writeActivityBatch(db, { roots: [root], spans: [root, child], events: [activityEvent(child)], batchSize: 1 });
    const options = { scope: { kind: "root", rootId: root.id } as const, asOf: new Date(), liveness, batchSize: 1, rootsPerBatch: 1 };
    expect(await deleteActivityBatch(db, options)).toEqual({ roots: 0, events: 1, found: true });
    expect(await db.select().from(activitySpans)).toHaveLength(2);
    expect(await deleteActivityBatch(db, options)).toEqual({ roots: 0, events: 0, found: true });
    expect(await db.select().from(activitySpans)).toHaveLength(1);
    expect(await deleteActivityBatch(db, options)).toEqual({ roots: 1, events: 0, found: true });
    expect(await deleteActivityBatch(db, options)).toEqual({ roots: 0, events: 0, found: false });
  });
  it("does not report done while another transaction (a concurrent prune) holds the roots it would delete", async () => {
    const db = connection.db;
    const root = activityRow({ status: "ok", startedAt: READ_AT });
    await writeActivityBatch(db, { roots: [root], spans: [root], events: [], batchSize: 1 });
    const holder = createConnection(inject("testDatabaseUrl"), { max: 1 });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve, reject) => {
      holder.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from activity_spans where id = ${root.id} for update`);
        resolve();
        await gate;
      }).catch(reject);
    });
    try {
      await held;
      const input = { scope: "all", asOf: new Date().toISOString() } as const;
      expect(await deleteActivityBatch(db, { scope: { kind: "all" }, asOf: new Date(), liveness, batchSize: 10, rootsPerBatch: 10 }))
        .toEqual({ roots: 0, events: 0, found: false, blocked: true });
      expect(await executeDelete(db, input)).toEqual({ status: "partial", roots: 0, events: 0 });
      expect(await activityCount()).toBe(1);
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await executeDelete(db, input)).toEqual({ status: "done", roots: 1, events: 0 });
    } finally {
      release();
      await holder.sql.end();
    }
  });
  it("reports partial when a tiny time budget expires and resumes with the same cutoff", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, f.ai.id));
    const input = { scope: "all" } as const;
    const preview = await previewDelete(db, input);
    expect(preview.status).toBe("ok"); if (preview.status !== "ok") throw new Error("preview unavailable");
    settings.ui.delete_budget_ms = 1;
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2);
    const first = await executeDelete(db, { ...input, asOf: preview.asOf });
    expect(first.status).toBe("partial");
    if (first.status !== "partial") throw new Error("expected partial");
    clock.mockRestore(); settings.ui.delete_budget_ms = 10_000;
    const second = await executeDelete(db, { ...input, asOf: preview.asOf });
    expect(second.status).toBe("done");
    if (second.status !== "done") throw new Error("expected completion");
    expect(first.roots + second.roots).toBe(preview.roots);
    expect(first.events + second.events).toBe(preview.events);
  });
  it("preserves every business table and AI usage aggregate when clearing all activity", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    await db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, f.ai.id));
    const before = await businessCounts();
    expect(Object.values(before).every((count) => count > 0)).toBe(true);
    const usage = await getAiUsageGroups(db, usageFilter, ["fixture-api"]);
    expect(usage).toHaveLength(1);
    const preview = await previewDelete(db, { scope: "all" });
    if (preview.status !== "ok") throw new Error("preview unavailable");
    expect(await executeDelete(db, { scope: "all", asOf: preview.asOf })).toEqual({ status: "done", roots: preview.roots, events: preview.events });
    expect(await activityCount()).toBe(0);
    expect(await businessCounts()).toEqual(before);
    expect(await getAiUsageGroups(db, usageFilter, ["fixture-api"])).toEqual(usage);
  });
  it("never returns sensitive business samples through any activity query or delete service", async () => {
    const db = connection.db;
    const f = await seedActivityReadFixture(db);
    // Poison the code-bearing JSON too: future/legacy writers cannot bypass the read boundary.
    await db.update(activityEvents).set({ params: { error_code: PRIVATE_SAMPLES[0], url: PRIVATE_SAMPLES[1], nested: { secret: PRIVATE_SAMPLES[3] }, valid: true } }).where(eq(activityEvents.code, "item.failed"));
    await db.update(activityEvents).set({ params: { fixture: PRIVATE_SAMPLES[2] } }).where(eq(activityEvents.code, "cascade_reasons"));
    const outputs: unknown[] = [
      await listActivityRoots(db, {}, { page: 1, pageSize: 20 }, liveness),
      await getActivityRoot(db, f.root.id, liveness), await getActivityRoot(db, f.attempt1.id, liveness),
      await listQueryRows(db, f.root.id), await listActivityEvents(db, f.root.id, { page: 1, pageSize: 20 }),
      await previewActivityDelete(db, { kind: "all" }, liveness), await previewDelete(db, { scope: "all" }),
    ];
    await db.update(controlRequests).set({ status: "done" }).where(eq(controlRequests.id, f.ai.id));
    const preview = await previewDelete(db, { scope: "all" });
    if (preview.status !== "ok") throw new Error("preview unavailable");
    outputs.push(await executeDelete(db, { scope: "all", asOf: preview.asOf }));
    const serialized = JSON.stringify(outputs);
    for (const sample of PRIVATE_SAMPLES) expect(serialized).not.toContain(sample);
  });
  it("returns not_ready for missing activity tables without touching business records", async () => {
    const db = connection.db;
    // Rollback restores the schema; readiness must not reuse an earlier positive cache in this scenario.
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`drop table activity_events,activity_spans`);
      resetActivityTablesCache();
      expect(await previewDelete(tx, { scope: "all" })).toEqual({ status: "not_ready" });
      expect(await executeDelete(tx, { scope: "all", asOf: new Date().toISOString() })).toEqual({ status: "not_ready" });
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    resetActivityTablesCache();
    expect(await activityTablesReady(db)).toBe(true);
  });
});
