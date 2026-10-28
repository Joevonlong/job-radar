import { sql } from "drizzle-orm";

import { loadRunnerEnv } from "@/lib/env";

import type { Db } from "./client";
import { acquireInstanceLock } from "./instance-lock";

/** Session lock shared by collection cycles and reprocessing. A crashed process cannot leave it behind. */
const CYCLE_LOCK_KEY = [0x4a52, 0x0001] as const;

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface CycleLockHolder {
  pid: number;
  /** Aborted if the lock session is lost, or the caller cancels. The lock is kept until the body settles. */
  signal: AbortSignal;
}

/** Run the body on its normal pool, keeping the advisory lock on a dedicated session with no lifetime or idle limit. */
export async function withCycleLock<T>(
  db: Db,
  mode: "try" | "wait",
  fn: (holder: CycleLockHolder) => Promise<T>,
  options: { signal?: AbortSignal; checkIntervalMs?: number } = {},
): Promise<LockResult<T>> {
  const checkIntervalMs = options.checkIntervalMs ?? loadRunnerEnv().RUNNER_HEARTBEAT_SECONDS * 1000;
  const acquired = await acquireInstanceLock(db, { name: "cycle", key: CYCLE_LOCK_KEY, mode, signal: options.signal });
  if (!acquired.acquired) return { acquired: false };
  const { lock } = acquired;
  const lost = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal;
  let checking: Promise<void> | undefined;
  const check = (): void => {
    if (checking || lost.signal.aborted) return;
    checking = lock.check().then((state) => {
      // Even reacquiring leaves a gap in exclusivity. Stop this body, and never return before it actually stops.
      if (state !== "held") lost.abort(new Error("cycle lock connection lost"));
    }).catch(() => { lost.abort(new Error("cycle lock connection lost")); }).finally(() => { checking = undefined; });
  };
  const timer = setInterval(check, checkIntervalMs);
  timer.unref();
  try {
    return { acquired: true, value: await fn({ pid: lock.pid, signal }) };
  } finally {
    clearInterval(timer);
    await checking;
    await lock.release();
  }
}

/** The backend pid holding the cycle lock in this database, or null. Locks in other databases never count. */
export async function findCycleLockHolder(db: Db): Promise<number | null> {
  const [k1, k2] = CYCLE_LOCK_KEY;
  const rows = await db.execute<{ pid: number }>(
    sql`select pid from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database()) and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2 limit 1`,
  );
  return rows[0] === undefined ? null : Number(rows[0].pid);
}
