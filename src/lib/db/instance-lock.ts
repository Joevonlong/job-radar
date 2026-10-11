import os from "node:os";

import postgres, { type Sql } from "postgres";

import { assertTestDatabase } from "./test-guard";

/**
 * A process-wide "only one of me" lock: a Postgres session advisory lock held on a connection of its own for as long as
 * the process lives. Postgres drops it when the process exits or its connection dies, so a crash never leaves it behind.
 * Locks are per database, so a test or e2e database never collides with the real one.
 */

/** Two int4s, like the cycle lock (`src/lib/cycle/lock.ts`, key [0x4a52, 0x0001]); must differ from it. */
export const AI_WORKER_LOCK_KEY = [0x4a52, 0x0002] as const;

/** What a refused process can say about the holder (from `pg_stat_activity`); fields are null when unknown. */
export interface LockHolder {
  /** The holder's `application_name`: `job-radar <name> pid=<pid> host=<host>`. */
  application: string | null;
  /** When the holder's connection started. */
  since: Date | null;
}

export interface InstanceLock {
  /**
   * Is the lock still ours? `held`: yes. `reacquired`: the connection had dropped (database restart) and the lock was
   * taken again. `lost`: another process holds it now; the caller should stop. `unknown`: the database cannot be
   * reached right now (nobody else can take the lock without it either); ask again later.
   */
  check(): Promise<"held" | "reacquired" | "lost" | "unknown">;
  release(): Promise<void>;
}

export type AcquireResult = { acquired: true; lock: InstanceLock } | { acquired: false; holder: LockHolder | null };

export interface AcquireOptions {
  /** Short process name for `application_name` (e.g. `ai-worker`). */
  name: string;
  key?: readonly [number, number];
  connectTimeoutSeconds?: number;
}

/** Queries `check` tries before it answers "unknown". */
const CHECK_ATTEMPTS = 3;

function applicationName(name: string): string {
  // Postgres truncates application_name to 63 bytes.
  return `job-radar ${name} pid=${process.pid} host=${os.hostname()}`.slice(0, 63);
}

async function tryLock(sql: Sql, k1: number, k2: number): Promise<boolean> {
  const rows = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${k1}::int, ${k2}::int) as locked`;
  return rows[0]?.locked === true;
}

async function holderOf(sql: Sql, k1: number, k2: number): Promise<LockHolder | null> {
  try {
    const rows = await sql<{ application_name: string | null; backend_start: Date | null }[]>`
      select a.application_name, a.backend_start
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database())
        and l.classid = ${k1}::int::oid and l.objid = ${k2}::int::oid and l.objsubid = 2
      limit 1`;
    const row = rows[0];
    return row ? { application: row.application_name || null, since: row.backend_start } : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock on a dedicated connection (no idle timeout, no lifetime limit: closing it would drop the lock), or
 * report who holds it. Throws only when the database cannot be reached.
 */
export async function acquireInstanceLock(url: string, options: AcquireOptions): Promise<AcquireResult> {
  const [k1, k2] = options.key ?? AI_WORKER_LOCK_KEY;
  assertTestDatabase(url);
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    connection: { application_name: applicationName(options.name) },
    onnotice: () => {},
  });
  let locked: boolean;
  try {
    locked = await tryLock(sql, k1, k2);
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
  if (!locked) {
    const holder = await holderOf(sql, k1, k2);
    await sql.end({ timeout: 5 }).catch(() => {});
    return { acquired: false, holder };
  }
  let released = false;
  return {
    acquired: true,
    lock: {
      async check() {
        if (released) return "lost";
        const look = async (): Promise<"held" | "reacquired" | "lost"> => {
          const rows = await sql<{ held: boolean }[]>`
            select exists (
              select 1 from pg_locks
              where locktype = 'advisory' and granted and pid = pg_backend_pid()
                and classid = ${k1}::int::oid and objid = ${k2}::int::oid and objsubid = 2
            ) as held`;
          if (rows[0]?.held === true) return "held";
          // The connection was replaced (postgres reconnects on its own): take the lock again if nobody else did.
          return (await tryLock(sql, k1, k2)) ? "reacquired" : "lost";
        };
        // After the server closed the connection the next queries fail (closed socket, then the termination notice)
        // until the client has reconnected: a few quick attempts, then "unknown" (the database is really away).
        for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt += 1) {
          try {
            return await look();
          } catch {
            // try again on a fresh connection
          }
        }
        return "unknown";
      },
      async release() {
        if (released) return;
        released = true;
        await sql.end({ timeout: 5 }).catch(() => {});
      },
    },
  };
}
