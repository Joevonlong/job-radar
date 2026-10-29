import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { createConnection } from "@/lib/db/client";
import { closeStaleSpans, openActivityConnection, resetActivityTablesCache, writeActivityBatch } from "@/lib/db/repos/activity";
import { activityEvents, activitySpans } from "@/lib/db/schema";
import { activityEvent, activityRow, integrationActivitySettings } from "./activity-helpers";

let connection: ReturnType<typeof createConnection>;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(() => resetActivityTablesCache());
afterAll(async () => { await connection.sql.end(); });

describe("activity storage", () => {
  it("upserts idempotently, protects terminal progress/links and advances root activity", async () => {
    const root = activityRow({ progressDone: 2, jobId: 99, status: "ok", finishedAt: new Date(), eventsDropped: 3 });
    const event = activityEvent(root, { at: new Date(root.lastActivityAt.getTime() + 1000) });
    const batch = { roots: [root], spans: [root], events: [event], batchSize: 1 };
    await writeActivityBatch(connection.db, batch); await writeActivityBatch(connection.db, batch);
    await writeActivityBatch(connection.db, { ...batch, spans: [{ ...root, status: "running", progressDone: 0, jobId: null, finishedAt: null, eventsDropped: 1, lastActivityAt: event.at }] });
    const [stored] = await connection.db.select().from(activitySpans);
    expect(stored).toMatchObject({ status: "ok", progressDone: 2, jobId: 99, eventsDropped: 3, finishedAt: root.finishedAt, lastActivityAt: event.at });
    expect(await connection.db.select().from(activityEvents)).toHaveLength(1);
  });
  it("takes newer running progress, least start, greatest drop count and the first terminal time", async () => {
    const root = activityRow({ progressDone: 1 });
    const write = (row: typeof root) => writeActivityBatch(connection.db, { roots: [root], spans: [row], events: [], batchSize: 1 });
    await write(root);
    const newer = { ...root, progressDone: 5, lastActivityAt: new Date(root.lastActivityAt.getTime() + 1000) };
    await write(newer); await write(root);
    expect((await connection.db.select().from(activitySpans))[0].progressDone).toBe(5);
    const earlier = new Date(root.startedAt.getTime() - 1000);
    await write({ ...newer, startedAt: earlier, status: "partial", finishedAt: newer.lastActivityAt });
    await write({ ...newer, status: "failed", finishedAt: new Date(newer.lastActivityAt.getTime() + 1000) });
    expect((await connection.db.select().from(activitySpans))[0]).toMatchObject({ startedAt: earlier, status: "partial", finishedAt: newer.lastActivityAt });
  });
  it("lets a real root replace the scope/name/process of a placeholder written by another process", async () => {
    const root = activityRow({ process: "ai-worker", scope: "cycle", name: "cycle", cycleId: 8 });
    const child = activityRow({ rootId: root.id, parentId: root.id, process: "ai-worker", scope: "cycle", name: "ai.score" });
    await writeActivityBatch(connection.db, { roots: [root], spans: [child], events: [activityEvent(child)], batchSize: 1 });
    const real = { ...root, process: "runner" as const, status: "ok" as const, finishedAt: new Date(), controlRequestId: 12 };
    await writeActivityBatch(connection.db, { roots: [root], spans: [real], events: [], batchSize: 1 });
    expect((await connection.db.select().from(activitySpans).where(eq(activitySpans.id, root.id)))[0]).toMatchObject({ process: "runner", scope: "cycle", name: "cycle", controlRequestId: 12, status: "ok" });
    // A late attachment is insert-only, so it cannot regress the completed root.
    await writeActivityBatch(connection.db, { roots: [root], spans: [], events: [], batchSize: 1 });
    expect((await connection.db.select().from(activitySpans).where(eq(activitySpans.id, root.id)))[0].status).toBe("ok");
  });
  it("cascades only the activity tree and permits missing parents, spans and business ids", async () => {
    const root = activityRow({ cycleId: 999, jobId: 888 });
    const child = activityRow({ rootId: root.id, parentId: activityRow().id });
    await writeActivityBatch(connection.db, { roots: [root], spans: [root, child], events: [activityEvent(child, { spanId: activityRow().id, rawPostingId: 777 })], batchSize: 1 });
    await connection.db.delete(activitySpans).where(eq(activitySpans.id, root.id));
    expect(await connection.db.select().from(activitySpans)).toHaveLength(0);
    expect(await connection.db.select().from(activityEvents)).toHaveLength(0);
  });
  it("closes only running spans of this process started strictly before startup", async () => {
    const before = new Date();
    const old = new Date(before.getTime() - 1000);
    const rows = [activityRow({ startedAt: old }), activityRow({ process: "ai-worker", startedAt: old }), activityRow({ startedAt: before }), activityRow({ startedAt: old, status: "ok" })];
    await writeActivityBatch(connection.db, { roots: rows, spans: rows, events: [], batchSize: 2 });
    expect(await closeStaleSpans(connection.db, { process: "runner", before })).toBe(1);
    expect(await connection.db.select().from(activitySpans).where(and(eq(activitySpans.status, "interrupted"), eq(activitySpans.process, "runner")))).toHaveLength(1);
  });
  it("uses a separate bounded connection with all session timeouts", async () => {
    const dedicated = openActivityConnection(connection.db, { connectTimeoutSeconds: 1, statementTimeoutMs: 731, lockTimeoutMs: 83 });
    try {
      const [row] = await dedicated.db.execute<{ statement: string; lock: string; idle: string; pid: number }>(sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle, pg_backend_pid() as pid`);
      expect(row).toMatchObject({ statement: "731ms", lock: "83ms", idle: "731ms" });
      const [shared] = await connection.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      expect(row.pid).not.toBe(shared.pid);
    } finally { await dedicated.sql.end(); }
  });
  it("retries a committed batch after a client error without duplicate events or dropped counts", async () => {
    const settings = integrationActivitySettings();
    let committed = false;
    const warn = vi.fn();
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn,
      writeBatch: async (db, batch) => { await writeActivityBatch(db, batch); if (!committed) { committed = true; throw new Error("commit response lost"); } },
    });
    try {
      const root = recorder.systemRoot("system.backup");
      root.note("info", "pruned", { invalid: "has spaces" }); root.item("item.ok"); root.finish("ok");
      await recorder.flush();
      await new Promise((resolve) => setTimeout(resolve, settings.writer.retry_backoff_ms + 1));
      await recorder.flush();
      expect(await connection.db.select().from(activityEvents)).toHaveLength(1);
      expect((await connection.db.select().from(activitySpans))[0].eventsDropped).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally { await recorder.close(); }
  });
});
