/** Shared health reads and response shaping for the health route. */
import { getDb, pingDb, readLatestHeartbeatAt, type Db } from "@/lib/db";

export interface HealthBody {
  db: "ok" | "error";
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
}

export interface HealthResult {
  status: 200 | 503;
  body: HealthBody;
}

/** Whole seconds since the heartbeat (never negative); null when there is none. */
export function computeHeartbeatAgeSeconds(lastHeartbeatAt: Date | null, now: Date): number | null {
  if (!lastHeartbeatAt) return null;
  return Math.max(0, Math.floor((now.getTime() - lastHeartbeatAt.getTime()) / 1000));
}

/** 200 only when the database is reachable; heartbeat fields are informational. */
export function shapeHealth(input: { dbOk: boolean; lastHeartbeatAt: Date | null; now: Date }): HealthResult {
  const lastHeartbeatAt = input.dbOk ? input.lastHeartbeatAt : null;
  return {
    status: input.dbOk ? 200 : 503,
    body: {
      db: input.dbOk ? "ok" : "error",
      lastHeartbeatAt: lastHeartbeatAt ? lastHeartbeatAt.toISOString() : null,
      heartbeatAgeSeconds: computeHeartbeatAgeSeconds(lastHeartbeatAt, input.now),
    },
  };
}

/** Read failures expose no connection details; a successful read may notify the route's startup reporter. */
export async function loadHealth(options: { db?: () => Db; at?: Date; onReachable?: () => void } = {}): Promise<HealthResult> {
  let dbOk = false;
  let lastHeartbeatAt: Date | null = null;
  try {
    const db = (options.db ?? getDb)();
    dbOk = await pingDb(db);
    if (dbOk) {
      lastHeartbeatAt = await readLatestHeartbeatAt(db);
      options.onReachable?.();
    }
  } catch (error) {
    console.error("[health] database unavailable:", error instanceof Error ? error.name : "unknown error");
  }
  return shapeHealth({ dbOk, lastHeartbeatAt, now: options.at ?? new Date() });
}
