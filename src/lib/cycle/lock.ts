import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";

/**
 * Advisory lock key of "a processing cycle is running" (two int4s; arbitrary but fixed). Held for the
 * duration of one transaction, so Postgres releases it when the holder finishes or its connection
 * dies — a crashed runner can never leave the lock behind.
 */
const CYCLE_LOCK_KEY = [0x4a52, 0x0001] as const;

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` while holding the cycle lock.
 * - `try`: if another process holds it, return `{ acquired: false }` immediately.
 * - `wait`: block until the lock is free.
 * The transaction exists only to scope the lock; `fn` does its own database work through the pool.
 */
export async function withCycleLock<T>(db: Db, mode: "try" | "wait", fn: () => Promise<T>): Promise<LockResult<T>> {
  const [k1, k2] = CYCLE_LOCK_KEY;
  return db.transaction(async (tx): Promise<LockResult<T>> => {
    if (mode === "try") {
      const rows = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${k1}::int, ${k2}::int) as locked`);
      if (rows[0]?.locked !== true) return { acquired: false };
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(${k1}::int, ${k2}::int)`);
    }
    return { acquired: true, value: await fn() };
  });
}
