import postgres from "postgres";

import { applicationName, holderOf, type LockHolder } from "./instance-lock";
import { assertTestDatabase } from "./test-guard";

/**
 * The Postgres session advisory lock that serializes writes to the user's config and profile files across the web, the
 * runner and host commands (`src/lib/config/write-lock.ts` is the part that knows about config). All of its SQL is here.
 */

/** Two int4s, registered next to the other process-wide keys in `instance-lock.ts`. */
export const CONFIG_WRITE_LOCK_KEY = [0x4a52, 0x0003] as const;

/** How often a waiting writer asks for the lock again. */
const POLL_MS = 100;

/** The database cannot be reached (connection refused, timeout, bad credentials). Never carries the URL. */
export class DbUnavailable extends Error {
  constructor() {
    super("the database cannot be reached");
    this.name = "DbUnavailable";
  }
}

export interface ConfigWriteLockHandle {
  /** Backend of the session that took the lock. */
  pid: number;
  /** True only while that same session holds the lock. A failed query is false. */
  fence(): Promise<boolean>;
  /** Unlock and close the session (closing alone drops the lock too). Never throws. */
  release(): Promise<void>;
}

export type ConfigWriteLockResult = { acquired: true; lock: ConfigWriteLockHandle } | { acquired: false; holder: LockHolder | null };

function settleWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wait up to `waitSeconds` for the lock on a connection of its own (no idle timeout or lifetime limit: closing it would
 * drop the lock). Throws `DbUnavailable` when the database cannot be reached.
 */
export async function acquireConfigWriteLock(url: string, options: { waitSeconds: number }): Promise<ConfigWriteLockResult> {
  assertTestDatabase(url);
  const [k1, k2] = CONFIG_WRITE_LOCK_KEY;
  const waitMs = options.waitSeconds * 1000;
  // A frozen database must not hang a save or the writers queued behind it: no query waits longer than this.
  const queryLimitMs = Math.max(1000, waitMs);
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: Math.max(1, Math.ceil(options.waitSeconds)),
    connection: { application_name: applicationName("config-write"), statement_timeout: Math.max(1, Math.ceil(waitMs)) },
    onnotice: () => {},
  });
  const close = (): Promise<void> => sql.end({ timeout: 5 }).catch(() => {});
  const deadline = Date.now() + waitMs;
  let pid = 0;
  for (;;) {
    try {
      const rows = await settleWithin(sql<{ ok: boolean; pid: number }[]>`select pg_try_advisory_lock(${k1}::int, ${k2}::int) as ok, pg_backend_pid() as pid`, queryLimitMs);
      if (rows[0]?.ok === true) {
        pid = rows[0].pid;
        break;
      }
    } catch {
      await close();
      throw new DbUnavailable();
    }
    if (Date.now() >= deadline) {
      const holder = await settleWithin(holderOf(sql, k1, k2), queryLimitMs).catch(() => null);
      await close();
      return { acquired: false, holder };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }

  let released = false;
  return {
    acquired: true,
    lock: {
      pid,
      async fence() {
        if (released) return false;
        try {
          const rows = await settleWithin(sql<{ pid: number; held: boolean }[]>`
            select pg_backend_pid() as pid, exists (
              select 1 from pg_locks
              where locktype = 'advisory' and granted and pid = pg_backend_pid()
                and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2
            ) as held`, queryLimitMs);
          return rows[0]?.pid === pid && rows[0]?.held === true;
        } catch {
          return false;
        }
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await settleWithin(sql`select pg_advisory_unlock(${k1}::int, ${k2}::int)`, queryLimitMs);
        } catch {
          // closing the session below drops the lock as well
        }
        await close();
      },
    },
  };
}
