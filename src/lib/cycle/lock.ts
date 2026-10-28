import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";

/**
 * Advisory lock key of "a processing cycle is running" (two int4s; arbitrary but fixed). Held for the
 * duration of one transaction, so Postgres releases it when the holder finishes or its connection
 * dies — a crashed runner can never leave the lock behind.
 */
const CYCLE_LOCK_KEY = [0x4a52, 0x0001] as const;

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/** Who holds the cycle lock: the Postgres backend of the transaction that took it. */
export interface CycleLockHolder {
  pid: number;
}

/**
 * Run `fn` while holding the cycle lock.
 * - `try`: if another process holds it, return `{ acquired: false }` immediately.
 * - `wait`: block until the lock is free.
 * The transaction exists only to scope the lock; `fn` does its own database work through the pool. `fn` gets the
 * backend pid of that transaction, which a cycle records so others can tell the holder from a row a crash left `running`.
 */
export async function withCycleLock<T>(db: Db, mode: "try" | "wait", fn: (holder: CycleLockHolder) => Promise<T>): Promise<LockResult<T>> {
  const [k1, k2] = CYCLE_LOCK_KEY;
  return db.transaction(async (tx): Promise<LockResult<T>> => {
    let pid: number | undefined;
    if (mode === "try") {
      const rows = await tx.execute<{ locked: boolean; pid: number }>(sql`select pg_try_advisory_xact_lock(${k1}::int, ${k2}::int) as locked, pg_backend_pid() as pid`);
      if (rows[0]?.locked !== true) return { acquired: false };
      pid = rows[0].pid;
    } else {
      const rows = await tx.execute<{ pid: number }>(sql`select pg_advisory_xact_lock(${k1}::int, ${k2}::int), pg_backend_pid() as pid`);
      pid = rows[0]?.pid;
    }
    return { acquired: true, value: await fn({ pid: Number(pid ?? 0) }) };
  });
}

/** The backend pid holding the cycle lock right now, or null when nobody does. */
export async function findCycleLockHolder(db: Db): Promise<number | null> {
  const [k1, k2] = CYCLE_LOCK_KEY;
  const rows = await db.execute<{ pid: number }>(
    sql`select pid from pg_locks where locktype = 'advisory' and granted and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2 limit 1`,
  );
  return rows[0] === undefined ? null : Number(rows[0].pid);
}
