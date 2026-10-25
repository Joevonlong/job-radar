import type { Sql } from "postgres";
import { z } from "zod";

import type { Db } from "../client";
import { AI_WORKER_LOCK_KEY, findInstanceLockHolder, instanceApplicationName } from "../instance-lock";
import { hasHeartbeatSince, HEARTBEAT_PROCESS } from "./heartbeats";

/**
 * Positive database evidence that a given ai-worker process is up (used by the host install tooling through
 * scripts/ops/worker-heartbeat.ts): the process holds the worker's instance lock, and a worker heartbeat was written at
 * or after both `since` and the start of the lock holder's connection. Everything comes from views the worker's own
 * database role can read; a holder of another role (its `application_name` / `backend_start` hidden) cannot be judged.
 */

/** A connection as `createConnection` returns it. */
export interface EvidenceConnection {
  sql: Sql;
  db: Db;
}

export const workerEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), reason: z.enum(["lock-and-heartbeat", "lock-heartbeat-report"]) }),
  z.object({
    status: z.literal("not_yet"),
    reason: z.enum(["no-holder", "other-holder", "no-heartbeat", "no-report"]),
    holder: z.string().nullable().optional(),
  }),
  z.object({ status: z.literal("unknown"), reason: z.enum(["holder-not-visible", "error"]), detail: z.string().optional() }),
]);
export type WorkerEvidence = z.infer<typeof workerEvidenceSchema>;

/** The database clock, in UTC with microseconds (`2026-01-02T03:04:05.123456Z`): the `since` to pass back later. */
export async function dbNow(sql: Sql): Promise<string> {
  const rows = await sql<{ now: string }[]>`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`;
  const now = rows[0]?.now;
  if (!now) throw new Error("dbNow: the query returned no row");
  return now;
}

/** Later of two timestamptz texts, compared by the database. */
async function later(sql: Sql, a: string, b: string): Promise<string> {
  const rows = await sql<{ t: string }[]>`
    select to_char(greatest(${a}::timestamptz, ${b}::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  const t = rows[0]?.t;
  if (!t) throw new Error("later: the query returned no row");
  return t;
}

/**
 * `found` when the instance-lock holder's `application_name` is exactly what a worker with `pid` on `host` sets (cut to
 * 63 characters as Postgres stores it) and an ai-worker heartbeat exists at or after max(`since`, holder's
 * `backend_start`); `not_yet` when nobody holds the lock, someone else does, or that heartbeat is not there yet;
 * `unknown` when the holder's session is not visible to this role. Query errors propagate (the caller reports unknown).
 */
export async function workerEvidence(conn: EvidenceConnection, opts: { pid: number; host: string; since: string }): Promise<WorkerEvidence> {
  return (await evidenceSince(conn, opts)).result;
}

/** Keep the exact SQL timestamp for the receipt's report comparison too (no JS Date rounding). */
async function evidenceSince(conn: EvidenceConnection, opts: { pid: number; host: string; since: string }): Promise<{ result: WorkerEvidence; atLeast: string | null }> {
  const holder = await findInstanceLockHolder(conn.sql, AI_WORKER_LOCK_KEY);
  if (!holder) return { result: { status: "not_yet", reason: "no-holder" }, atLeast: null };
  if (holder.application === null || holder.application === "" || holder.sinceExact === null) {
    return { result: { status: "unknown", reason: "holder-not-visible" }, atLeast: null };
  }
  if (holder.application !== instanceApplicationName("ai-worker", opts.pid, opts.host)) {
    return { result: { status: "not_yet", reason: "other-holder", holder: holder.application }, atLeast: null };
  }
  const atLeast = await later(conn.sql, opts.since, holder.sinceExact);
  const result: WorkerEvidence = (await hasHeartbeatSince(conn.db, HEARTBEAT_PROCESS.aiWorker, atLeast))
    ? { status: "found", reason: "lock-and-heartbeat" }
    : { status: "not_yet", reason: "no-heartbeat" };
  return { result, atLeast };
}

/** Evidence plus this PID's own shipped config report, at or after both `since` and its lock connection's start. */
export async function workerReceipt(conn: EvidenceConnection, { pid, host, since }: { pid: number; host: string; since: string }): Promise<WorkerEvidence> {
  const { result, atLeast } = await evidenceSince(conn, { pid, host, since });
  if (result.status !== "found") return result;
  const rows = await conn.sql<{ ok: boolean }[]>`
    select exists (select 1 from runtime_state
      where key = 'shipped_config:ai-worker'
        and value->>'pid' = ${String(pid)} and value->>'instance' = ${host}
        and updated_at >= ${atLeast}::timestamptz) as ok`;
  return rows[0]?.ok
    ? { status: "found", reason: "lock-heartbeat-report" }
    : { status: "not_yet", reason: "no-report" };
}
