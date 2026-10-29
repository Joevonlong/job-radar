import net from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { activityInternals, createActivityRecorder } from "@/lib/activity/recorder";
import { closeStaleActivity, pruneActivityLog, reconcileActivity, startActivityMaintenance } from "@/lib/activity/maintenance";
import type { ActivityRecorder } from "@/lib/activity/types";
import { noopSpan } from "@/lib/activity/noop";
import { createConnection } from "@/lib/db/client";
import { activityTablesReady, openActivityConnection, resetActivityTablesCache, writeActivityBatch } from "@/lib/db/repos/activity";
import { activityEvents, activitySpans, cycles, runnerHeartbeats } from "@/lib/db/schema";
import { createIsolatedDb } from "../helpers/isolated-db";
import { integrationActivitySettings } from "./activity-helpers";

let connection: ReturnType<typeof createConnection>;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(() => resetActivityTablesCache());
afterAll(async () => { await connection.sql.end(); });

/** Holds the table lock only on a separate test session; it never touches an installation. */
async function withActivityLock(work: () => Promise<void>): Promise<void> {
  const locker = createConnection(inject("testDatabaseUrl"), { max: 1 });
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const untilRelease = new Promise<void>((resolve) => { release = resolve; });
  const transaction = locker.sql.begin(async (tx) => { await tx`lock table activity_spans in access exclusive mode`; acquired(); await untilRelease; });
  // Do not hang the test if taking the lock itself fails.
  await Promise.race([held, transaction]);
  try { await work(); } finally { release(); await transaction; await locker.sql.end(); }
}

describe("activity failures stay isolated", () => {
  it("applies reloaded statement timeouts to flush and maintenance sessions", async () => {
    const settings = integrationActivitySettings();
    const observed: number[] = [];
    const timeoutIn = async (db: typeof connection.db) => {
      const [row] = await db.execute<{ milliseconds: number }>(sql`select setting::int as milliseconds from pg_settings where name = 'statement_timeout'`);
      return row.milliseconds;
    };
    const warn = vi.fn();
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn,
      writeBatch: async (db, batch) => { observed.push(await timeoutIn(db)); await writeActivityBatch(db, batch); },
    });
    try {
      recorder.systemRoot("system.backup").finish("ok"); await recorder.flush();
      expect(observed).toEqual([settings.writer.statement_timeout_ms]);
      settings.writer.statement_timeout_ms = 250;
      recorder.systemRoot("system.backup").finish("ok"); await recorder.flush();
      expect(observed).toEqual([1000, settings.writer.statement_timeout_ms]);
      const internal = activityInternals(recorder)!;
      expect(await internal.runMaintenance(timeoutIn)).toBe(settings.writer.statement_timeout_ms);
      // An actual statement longer than the new timeout is cancelled by Postgres, before the client deadline.
      let code: string | undefined;
      await internal.runMaintenance(async (db) => {
        try { await db.execute(sql`select pg_sleep(${(settings.writer.statement_timeout_ms * 2) / 1000})`); }
        catch (error) { code = (error as { cause?: { code?: string } }).cause?.code; throw error; }
      });
      expect(code).toBe("57014");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { await recorder.close(); }
  });
  it.each([
    ["startup close-out", closeStaleActivity], ["reconciliation", reconcileActivity], ["pruning", pruneActivityLog], ["flush", (recorder: ActivityRecorder) => recorder.flush()],
  ] as const)("%s gives up on a table lock while business writes and heartbeats still work", async (_name, operation) => {
    const settings = integrationActivitySettings();
    const warn = vi.fn();
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn });
    try {
      await activityTablesReady(connection.db);
      recorder.systemRoot("system.backup").finish("ok");
      await withActivityLock(async () => {
        const started = Date.now();
        const pending = operation(recorder);
        await connection.db.insert(cycles).values({ kind: "manual", status: "succeeded" });
        await connection.db.insert(runnerHeartbeats).values({ process: "runner" });
        await expect(pending).resolves.toBeUndefined();
        expect(Date.now() - started).toBeLessThan(settings.writer.flush_deadline_ms + 500);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).not.toMatch(/postgres|lock table|select|insert|password/);
      });
      expect(await connection.db.select().from(cycles)).toHaveLength(1);
      expect(await connection.db.select().from(runnerHeartbeats)).toHaveLength(1);
    } finally { await recorder.close(); }
  });
  it("returns from startup maintenance immediately and respects the client deadline even with a longer server lock timeout", async () => {
    const settings = integrationActivitySettings();
    settings.writer.lock_timeout_ms = 10_000;
    settings.writer.statement_timeout_ms = 10_000;
    // Deliberate fault injection bypasses schema checks to force the client cancellation path.
    settings.writer.flush_deadline_ms = 100;
    const warn = vi.fn();
    const opened: ReturnType<typeof openActivityConnection>[] = [];
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn,
      openConnection: (db, options) => { const conn = openActivityConnection(db, options); opened.push(conn); return conn; },
    });
    try {
      await activityTablesReady(connection.db);
      await withActivityLock(async () => {
        const started = Date.now();
        const maintenance = startActivityMaintenance({ recorder });
        expect(Date.now() - started).toBeLessThan(100);
        await connection.db.insert(runnerHeartbeats).values({ process: "runner" });
        await new Promise((resolve) => setTimeout(resolve, settings.writer.flush_deadline_ms * 3));
        maintenance.stop();
        expect(warn).toHaveBeenCalled();
        expect(warn.mock.calls.flat().join(" ")).toContain("timeout");
      });
    } finally { await recorder.close(); for (const conn of opened) await conn.sql.end({ timeout: 0 }); }
  });
  it("handles a closed test port within the flush deadline", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const url = new URL(inject("testDatabaseUrl")); url.hostname = "127.0.0.1"; url.port = String(address.port);
    const unreachable = createConnection(url.toString(), { connectTimeoutSeconds: 1 });
    const settings = integrationActivitySettings();
    const warn = vi.fn();
    const recorder = createActivityRecorder({ db: unreachable.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn });
    try {
      recorder.cycleRoot(1).finish("ok");
      const started = Date.now(); await expect(recorder.flush()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(settings.writer.flush_deadline_ms + 500);
      expect(warn).toHaveBeenCalled();
    } finally { await recorder.close(); await unreachable.sql.end({ timeout: 0 }); }
  });
  it("counts overflow on the span and recovers after an injected write exception", async () => {
    const settings = integrationActivitySettings(); settings.writer.queue_max = 1; settings.writer.batch_size = 1;
    let failed = false;
    const recorder = createActivityRecorder({ db: connection.db, process: "runner", autoFlush: false, loadSettings: () => settings, warn: vi.fn(),
      writeBatch: async (db, batch) => { if (!failed) { failed = true; throw new Error("injected failure"); } await writeActivityBatch(db, batch); },
    });
    try {
      const root = recorder.cycleRoot(1); root.item("item.ok"); root.item("item.ok");
      expect(root.child("step.collect")).toBe(noopSpan); root.finish("ok");
      await expect(recorder.flush()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, settings.writer.retry_backoff_ms + 1)); await recorder.flush();
      expect((await connection.db.select().from(activitySpans))[0]).toMatchObject({ eventsDropped: 2, status: "ok" });
      expect(await connection.db.select().from(activityEvents)).toHaveLength(0);
    } finally { await recorder.close(); }
  });
  it("only counts drops when the activity tables are absent in an isolated database", async () => {
    const isolated = await createIsolatedDb(inject("testDatabaseUrl"), "activity_missing");
    const db = createConnection(isolated.url);
    const warn = vi.fn();
    const writeBatch = vi.fn(writeActivityBatch);
    const settings = integrationActivitySettings();
    const recorder = createActivityRecorder({ db: db.db, process: "ai-worker", autoFlush: false, loadSettings: () => settings, writeBatch, warn });
    try {
      await db.db.execute(sql`alter table activity_events rename to saved_activity_events`);
      await db.db.execute(sql`alter table activity_spans rename to saved_activity_spans`);
      resetActivityTablesCache();
      const span = recorder.systemRoot("system.backup"); span.item("item.ok");
      await expect(recorder.flush()).resolves.toBeUndefined();
      expect(writeBatch).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
      await db.db.execute(sql`alter table saved_activity_spans rename to activity_spans`);
      await db.db.execute(sql`alter table saved_activity_events rename to activity_events`);
      span.finish("ok"); await recorder.flush();
      expect((await db.db.select().from(activitySpans))[0].eventsDropped).toBe(1);
      expect(await db.db.select().from(activityEvents)).toHaveLength(0);
    } finally { await recorder.close(); await db.sql.end(); await isolated.drop(); resetActivityTablesCache(); }
  });
});
