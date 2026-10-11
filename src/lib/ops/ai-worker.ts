import { z } from "zod";

import type { AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  AI_CONTROL_REQUEST_KINDS,
  countOpenControlRequests,
  getLatestFinishedControlRequest,
  type ControlRequest,
} from "@/lib/db/repos/control-requests";
import { getLatestHeartbeat, HEARTBEAT_PROCESS } from "@/lib/db/repos/heartbeats";
import { computeHeartbeatAgeSeconds } from "@/lib/health";

/** What `/sources` and the runner's offline alert know about the host ai-worker. */
export interface AiWorkerStatus {
  execution: AiConfig["execution"];
  /** Heartbeat newer than `offlineAfterSeconds`. */
  online: boolean;
  lastHeartbeatAt: Date | null;
  ageSeconds: number | null;
  offlineAfterSeconds: number;
  /** Requests for the worker that have not finished. */
  queue: { pending: number; running: number; oldestPendingAt: Date | null };
  /** The newest finished `run_ai`, or null when there was none yet. */
  lastRun: LastRunAi | null;
}

export interface LastRunAi {
  requestId: number;
  status: "done" | "failed";
  finishedAt: Date | null;
  cycleId: number | null;
  /** Machine-readable failure code (`ai_failed`, `cycle_not_found`, `aborted`, ...). */
  error: string | null;
  aiStatus: string | null;
  scored: number | null;
  translated: number | null;
  notifyStatus: string | null;
  pushed: number | null;
}

/** Pure: whether a heartbeat age counts as online. No heartbeat at all is offline. */
export function isWorkerOnline(ageSeconds: number | null, offlineAfterSeconds: number): boolean {
  return ageSeconds !== null && ageSeconds <= offlineAfterSeconds;
}

const count = z.number().nullable().catch(null);
const label = z.string().nullable().catch(null);
const runAiResultSchema = z
  .object({
    cycleId: z.number().int().nullable().catch(null),
    error: label,
    ai: z.object({ status: label, scored: count, translated: count }).partial().catch({}),
    notify: z.object({ status: label, pushed: count }).partial().catch({}),
  })
  .partial();

/** Pure: the `run_ai` request row → what the page shows (anything unexpected in `result` shows as unknown). */
export function lastRunOf(request: ControlRequest | null): LastRunAi | null {
  if (request === null || (request.status !== "done" && request.status !== "failed")) return null;
  const parsed = runAiResultSchema.safeParse(request.result ?? {});
  const result = parsed.success ? parsed.data : {};
  return {
    requestId: request.id,
    status: request.status,
    finishedAt: request.finishedAt,
    cycleId: result.cycleId ?? null,
    error: result.error ?? null,
    aiStatus: result.ai?.status ?? null,
    scored: result.ai?.scored ?? null,
    translated: result.ai?.translated ?? null,
    notifyStatus: result.notify?.status ?? null,
    pushed: result.notify?.pushed ?? null,
  };
}

/** Read the worker's heartbeat, queue and last `run_ai` from the database. */
export async function loadAiWorkerStatus(db: Db, input: { now: Date; aiConfig: Pick<AiConfig, "execution" | "host_worker"> }): Promise<AiWorkerStatus> {
  const [heartbeat, queue, lastRun] = await Promise.all([
    getLatestHeartbeat(db, HEARTBEAT_PROCESS.aiWorker),
    countOpenControlRequests(db, AI_CONTROL_REQUEST_KINDS),
    getLatestFinishedControlRequest(db, "run_ai"),
  ]);
  const ageSeconds = computeHeartbeatAgeSeconds(heartbeat?.at ?? null, input.now);
  const offlineAfterSeconds = input.aiConfig.host_worker.offline_after_seconds;
  return {
    execution: input.aiConfig.execution,
    online: isWorkerOnline(ageSeconds, offlineAfterSeconds),
    lastHeartbeatAt: heartbeat?.at ?? null,
    ageSeconds,
    offlineAfterSeconds,
    queue,
    lastRun: lastRunOf(lastRun),
  };
}

/**
 * Pure: should the runner warn that the ai-worker is gone? Only with `execution: host` (then nothing else does
 * the AI). `since` is when the watcher itself started: a worker that has not beaten yet is given the whole
 * `offlineAfterSeconds` from then, so a Mac that boots the runner first does not alert.
 */
export function aiWorkerOfflineSeconds(input: { execution: AiConfig["execution"]; lastHeartbeatAt: Date | null; since: Date; now: Date; offlineAfterSeconds: number }): number | null {
  if (input.execution !== "host") return null;
  const reference = input.lastHeartbeatAt ?? input.since;
  const age = Math.floor((input.now.getTime() - reference.getTime()) / 1000);
  return age > input.offlineAfterSeconds ? age : null;
}
