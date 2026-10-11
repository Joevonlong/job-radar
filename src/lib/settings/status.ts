/** Server side of the settings page's live status: runner heartbeat, reload acknowledgements, control requests. */
import { z } from "zod";

import { loadRunnerEnv } from "@/lib/env";
import {
  countStaleScores,
  countUnscoredJobs,
  findManualCycleSince,
  getCycleProgress,
  getDbNow,
  getOpenAiRun,
  getLatestHeartbeat,
  listControlRequests,
  SETTINGS_REQUEST_KINDS,
  type ControlRequest,
  type CycleProgress,
  type Db,
} from "@/lib/db";

import { ackState, diskConfigHash, readConfigAcks, type ConfigAck } from "./ack";
import { HEARTBEAT_STALE_FACTOR, RECENT_REQUESTS } from "./constants";
import { controlStatusSchema, type ConfigAckView, type ControlRequestView, type ControlStatus } from "./status-schema";
import { ACK_NAMES, type AckName } from "./tabs";

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Machine-readable parts of `control_requests.result` the page understands (anything else is ignored). */
const resultSchema = z
  .object({
    cycleId: z.number().int().nullable().optional(),
    error: z.string().optional(),
    scored: z.number().int().optional(),
    failed: z.number().int().optional(),
    placeholder: z.boolean().optional(),
  })
  .passthrough();

const payloadSchema = z.object({ channelIds: z.array(z.string()).optional(), jobIds: z.array(z.number().int()).optional() }).passthrough();

function progressView(progress: CycleProgress | null): ControlRequestView["cycle"] {
  if (!progress) return null;
  return {
    id: progress.id,
    status: progress.status,
    startedAt: progress.startedAt.toISOString(),
    finishedAt: iso(progress.finishedAt),
    runsTotal: progress.runsTotal,
    runsFinished: progress.runsFinished,
    fetched: progress.fetched,
    newCount: progress.newCount,
  };
}

type SettingsRequest = ControlRequest & { kind: ControlRequestView["kind"] };
const isSettingsRequest = (request: ControlRequest): request is SettingsRequest =>
  (SETTINGS_REQUEST_KINDS as readonly ControlRequest["kind"][]).includes(request.kind);

async function requestView(db: Db, request: SettingsRequest): Promise<ControlRequestView> {
  const result = resultSchema.safeParse(request.result ?? {});
  const payload = payloadSchema.safeParse(request.payload ?? {});
  let cycleId = result.success ? (result.data.cycleId ?? null) : null;
  if (cycleId === null && request.kind === "run_cycle" && request.status === "running" && request.startedAt) {
    cycleId = await findManualCycleSince(db, request.startedAt);
  }
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    startedAt: iso(request.startedAt),
    finishedAt: iso(request.finishedAt),
    channelIds: payload.success ? (payload.data.channelIds ?? null) : null,
    jobIds: payload.success ? (payload.data.jobIds ?? null) : null,
    error: result.success ? (result.data.error ?? null) : null,
    scored: result.success ? (result.data.scored ?? null) : null,
    failed: result.success ? (result.data.failed ?? null) : null,
    placeholder: result.success ? (result.data.placeholder ?? false) : false,
    cycle: cycleId === null ? null : progressView(await getCycleProgress(db, cycleId)),
  };
}

/** Heartbeat age and whether the runner counts as alive (see `HEARTBEAT_STALE_FACTOR`). */
export function heartbeatView(at: Date | null, now: Date): ControlStatus["heartbeat"] {
  if (!at) return { at: null, ageSeconds: null, online: false };
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  const limit = loadRunnerEnv().RUNNER_HEARTBEAT_SECONDS * HEARTBEAT_STALE_FACTOR;
  return { at: at.toISOString(), ageSeconds, online: ageSeconds <= limit };
}

function ackView(tab: AckName, ack: ConfigAck | null): ConfigAckView {
  return { state: ackState(diskConfigHash(tab), ack), loadedAt: iso(ack?.loadedAt ?? null) };
}

/** `now` defaults to the database clock: heartbeats are stamped by it, so ages must be measured with it. */
export async function loadControlStatus(db: Db, at?: Date): Promise<ControlStatus> {
  const now = at ?? (await getDbNow(db));
  const [heartbeat, acks, requests, staleScores, unscoredJobs, aiRun] = await Promise.all([
    getLatestHeartbeat(db),
    readConfigAcks(db),
    listControlRequests(db, RECENT_REQUESTS, SETTINGS_REQUEST_KINDS),
    countStaleScores(db),
    countUnscoredJobs(db),
    getOpenAiRun(db),
  ]);
  const status: ControlStatus = {
    now: now.toISOString(),
    heartbeat: heartbeatView(heartbeat?.at ?? null, now),
    staleScores,
    unscoredJobs,
    acks: Object.fromEntries(ACK_NAMES.map((name) => [name, ackView(name, acks[name])])) as ControlStatus["acks"],
    requests: await Promise.all(requests.filter(isSettingsRequest).map((request) => requestView(db, request))),
    aiRun: aiRun
      ? {
          requestId: aiRun.requestId,
          status: aiRun.status,
          cycleId: aiRun.cycleId,
          elapsedSeconds: Math.max(0, Math.floor((now.getTime() - (aiRun.startedAt ?? aiRun.requestedAt).getTime()) / 1000)),
          scored: aiRun.scored,
          translated: aiRun.translated,
        }
      : null,
  };
  return controlStatusSchema.parse(status);
}
