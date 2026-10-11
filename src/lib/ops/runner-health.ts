import type { Db } from "@/lib/db/client";
import { readLatestHeartbeatAt } from "@/lib/db/health";
import { computeHeartbeatAgeSeconds } from "@/lib/health";

export interface RunnerHealth {
  healthy: boolean;
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  reason: "ok" | "no heartbeat" | "heartbeat too old";
}

/** Pure verdict: healthy while the newest heartbeat is at most `maxAgeSeconds` old. */
export function evaluateHeartbeat(input: { lastHeartbeatAt: Date | null; now: Date; maxAgeSeconds: number }): RunnerHealth {
  const ageSeconds = computeHeartbeatAgeSeconds(input.lastHeartbeatAt, input.now);
  const base = {
    lastHeartbeatAt: input.lastHeartbeatAt ? input.lastHeartbeatAt.toISOString() : null,
    ageSeconds,
    maxAgeSeconds: input.maxAgeSeconds,
  };
  if (ageSeconds === null) return { ...base, healthy: false, reason: "no heartbeat" };
  if (ageSeconds > input.maxAgeSeconds) return { ...base, healthy: false, reason: "heartbeat too old" };
  return { ...base, healthy: true, reason: "ok" };
}

/** Read the newest heartbeat (an unreachable database counts as "no heartbeat") and judge it. */
export async function checkRunnerHealth(db: Db, options: { maxAgeSeconds: number; now?: () => Date }): Promise<RunnerHealth> {
  const lastHeartbeatAt = await readLatestHeartbeatAt(db);
  return evaluateHeartbeat({ lastHeartbeatAt, now: (options.now ?? (() => new Date()))(), maxAgeSeconds: options.maxAgeSeconds });
}
