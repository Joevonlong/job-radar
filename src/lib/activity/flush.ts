import type { ActivityLogConfig } from "@/lib/config/schemas/activity-log";
import type { Db } from "@/lib/db/client";
import { activityTablesReady, openActivityConnection, writeActivityBatch } from "@/lib/db/repos/activity";
import { TimeoutError, withTimeout } from "@/lib/ops/timeout";
import type { ActivityBatch } from "./types";

export interface FlushDependencies {
  db: Db;
  settings(): ActivityLogConfig | undefined;
  refresh(): void;
  now(): Date;
  warn(error: unknown): void;
  take(): ActivityBatch;
  settle(batch: ActivityBatch, outcome: "written" | "retry" | "not_ready"): void;
  openConnection?: typeof openActivityConnection;
  writeBatch?: typeof writeActivityBatch;
}

/** Serializes all work on the private pool, and destroys that pool when a client deadline expires. */
export function createActivityFlusher(deps: FlushDependencies) {
  let connection: ReturnType<typeof openActivityConnection> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let flushing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let retryAt = 0;

  const destroy = (): void => {
    const old = connection;
    connection = undefined;
    try { void old?.sql.end({ timeout: 0 }).catch(() => {}); } catch { /* Closing is best effort. */ }
  };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => {});
    return result;
  };
  const run = async <T>(work: (db: Db) => Promise<T>): Promise<T | undefined> => {
    const settings = deps.settings();
    if (!settings || stopped) return undefined;
    try {
      return await withTimeout(Promise.resolve().then(async () => {
        connection ??= (deps.openConnection ?? openActivityConnection)(deps.db, {
          connectTimeoutSeconds: settings.writer.connect_timeout_seconds,
          statementTimeoutMs: settings.writer.statement_timeout_ms,
          lockTimeoutMs: settings.writer.lock_timeout_ms,
        });
        return work(connection.db);
      }), settings.writer.flush_deadline_ms, "activity");
    } catch (error) {
      if (error instanceof TimeoutError) destroy();
      throw error;
    }
  };
  const flush = (allowClosing = false): Promise<void> => {
    if (flushing) return flushing;
    if (stopped || (closing && !allowClosing)) return Promise.resolve();
    flushing = serial(async () => {
      let batch: ActivityBatch | undefined;
      try {
        deps.refresh();
        if (!deps.settings() || stopped || (!allowClosing && deps.now().getTime() < retryAt)) return;
        batch = deps.take();
        if (!batch.roots.length && !batch.spans.length && !batch.events.length) return;
        const ready = await run(async (db) => {
          if (!await activityTablesReady(db)) return false;
          await (deps.writeBatch ?? writeActivityBatch)(db, batch!);
          return true;
        });
        deps.settle(batch, ready ? "written" : "not_ready");
      } catch (error) {
        if (batch) deps.settle(batch, "retry");
        retryAt = deps.now().getTime() + (deps.settings()?.writer.retry_backoff_ms ?? 0);
        deps.warn(error);
      }
    }).catch((error: unknown) => { deps.warn(error); }).finally(() => { flushing = undefined; });
    return flushing;
  };
  const runMaintenance = <T>(work: (db: Db) => Promise<T>): Promise<T | undefined> => {
    if (closing || stopped) return Promise.resolve(undefined);
    return serial(async () => {
      try {
        return await run(async (db) => await activityTablesReady(db) ? work(db) : undefined);
      } catch (error) { deps.warn(error); return undefined; }
    }).catch((error: unknown) => { deps.warn(error); return undefined; });
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    const outstanding = flushing;
    closing = (async () => {
      try {
        const settings = deps.settings();
        if (settings) {
          await withTimeout((async () => {
            await outstanding;
            await flush(true);
            await tail;
            if (connection) await connection.sql.end({ timeout: 0 });
          })(), settings.writer.shutdown_flush_ms, "activity shutdown");
        }
      } catch (error) { deps.warn(error); }
      finally { stopped = true; destroy(); }
    })().catch(() => {});
    return closing;
  };
  return { flush, close, runMaintenance };
}
