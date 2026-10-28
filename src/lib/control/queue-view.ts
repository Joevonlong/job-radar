/**
 * Server side of "where does my request stand": the queue position (`describeControlQueue`), the process that claims the
 * request's kind (`kinds.ts` with `ai.yaml: execution`) and whether that process is alive (its heartbeat, judged with the
 * settings that already exist: `ai.yaml: host_worker.offline_after_seconds` for the ai-worker, `RUNNER_HEARTBEAT_SECONDS`
 * for the runner). No wait limit of its own: a request waits as long as its process is alive.
 */
import { loadConfig, type AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getDbNow } from "@/lib/db/repos/cycles";
import { describeControlQueue, type ControlQueuePosition, type ControlRequest, type ControlRequestKind } from "@/lib/db/repos/control-requests";
import { getLatestHeartbeat } from "@/lib/db/repos/heartbeats";
import { computeHeartbeatAgeSeconds } from "@/lib/health";
import { isWorkerOnline } from "@/lib/ops/ai-worker";
import { heartbeatView } from "@/lib/settings/status";

import { aiWorkerRequestKinds, runnerRequestKinds } from "./kinds";
import { controlQueueViewSchema, type ControlProcess, type ControlQueueView } from "./request-view-schema";

type Execution = AiConfig["execution"];

/** Pure: the process that claims requests of `kind` under `execution`, or null when none does. */
export function requestProcessOf(kind: ControlRequestKind, execution: Execution): ControlProcess | null {
  if (aiWorkerRequestKinds(execution).includes(kind)) return "ai-worker";
  if (runnerRequestKinds(execution).includes(kind)) return "runner";
  return null;
}

/** The kinds the process claims (the same lists its poller uses). */
function processKinds(process: ControlProcess, execution: Execution): ControlRequestKind[] {
  return process === "ai-worker" ? aiWorkerRequestKinds(execution) : runnerRequestKinds(execution);
}

/** Pure: whether `process` counts as alive with a newest heartbeat at `heartbeatAt`. No process, or no heartbeat, is offline. */
export function workerOnline(input: { process: ControlProcess | null; heartbeatAt: Date | null; now: Date; offlineAfterSeconds: number }): boolean {
  if (input.process === null) return false;
  if (input.process === "ai-worker") return isWorkerOnline(computeHeartbeatAgeSeconds(input.heartbeatAt, input.now), input.offlineAfterSeconds);
  return heartbeatView(input.heartbeatAt, input.now).online;
}

/**
 * Pure: the `queue` of a request, or null once it is finished (done / failed). `position` null (the row went away between
 * two reads) counts as nothing ahead.
 */
export function buildQueueView(input: {
  status: ControlRequest["status"];
  process: ControlProcess | null;
  position: ControlQueuePosition | null;
  heartbeatAt: Date | null;
  now: Date;
  offlineAfterSeconds: number;
}): ControlQueueView | null {
  if (input.status !== "pending" && input.status !== "running") return null;
  const position = input.position;
  return controlQueueViewSchema.parse({
    ahead: input.status === "pending" ? (position?.ahead ?? 0) : 0,
    running: position?.running ? { kind: position.running.kind, since: position.running.since.toISOString() } : null,
    startedAt: position?.startedAt ? position.startedAt.toISOString() : null,
    now: input.now.toISOString(),
    worker: {
      process: input.process,
      online: workerOnline(input),
      heartbeatAgeSeconds: input.process === null ? null : computeHeartbeatAgeSeconds(input.heartbeatAt, input.now),
    },
  });
}

/**
 * Read the queue view of one request from the database (null when it is finished). `ai` defaults to the loaded `ai.yaml`;
 * `now` to the database clock, which stamps the heartbeats and `started_at`.
 */
export async function loadQueueView(
  db: Db,
  request: Pick<ControlRequest, "id" | "kind" | "status">,
  options: { ai?: Pick<AiConfig, "execution" | "host_worker">; now?: Date } = {},
): Promise<ControlQueueView | null> {
  if (request.status !== "pending" && request.status !== "running") return null;
  const ai = options.ai ?? loadConfig("ai");
  const process = requestProcessOf(request.kind, ai.execution);
  const [now, position, heartbeat] = await Promise.all([
    options.now ?? getDbNow(db),
    describeControlQueue(db, { requestId: request.id, kinds: process === null ? [] : processKinds(process, ai.execution) }),
    process === null ? null : getLatestHeartbeat(db, process),
  ]);
  return buildQueueView({ status: request.status, process, position, heartbeatAt: heartbeat?.at ?? null, now, offlineAfterSeconds: ai.host_worker.offline_after_seconds });
}
