/** Pure helpers behind `/api/health`; no I/O so they are trivially unit-testable. */

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
