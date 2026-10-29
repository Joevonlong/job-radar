/**
 * Web side of the control channel: validates what the browser asks for and leaves a row in
 * `control_requests`. The runner does the work (see `poller.ts`); this module never runs a cycle.
 */
import { logActionFailure } from "@/lib/logging/action-failure";
import { isConfiguredChannelId } from "@/lib/channels/registry";
import { loadConfig } from "@/lib/config";
import {
  countStaleScores,
  countUnscoredJobs,
  findOpenControlRequest,
  getDb,
  getDbNow,
  insertControlRequest,
  jobWaitsForScore,
  listControlRequests,
  listOpenControlRequests,
  OPEN_CONTROL_STATUSES,
  queueRunCycleRequest,
  type ControlRequest,
  type ControlRequestKind,
  type Db,
} from "@/lib/db";
import { createProcessLogger } from "@/lib/logging/process-logger";

import { cycleCovers, type CoverageCascade } from "./cycle-coverage";
import { runCyclePayloadSchema, scoreJobsPayloadSchema, testAiPayloadSchema, testChannelPayloadSchema, type ScoreJobsPayload } from "./types";
import type { ControlActionState } from "./service-types";

export type { ControlActionState } from "./service-types";

/** Every request a button creates is logged (web process output). */
const log = createProcessLogger({ fields: { component: "control" } });

const fail = (error: Extract<ControlActionState, { status: "error" }>["error"]): ControlActionState => ({ status: "error", error, nonce: Date.now() });
const queued = (row: ControlRequest, existing: boolean): ControlActionState => ({
  status: "queued",
  request: row.id,
  kind: row.kind,
  existing,
  nonce: Date.now(),
});

/** The channel cascades a cycle collects with (sources.yaml `linkedin.cascade`); null when the file cannot be read. */
function currentCascades(): CoverageCascade[] | null {
  try {
    return [{ order: loadConfig("channels").linkedin.cascade }];
  } catch (error) {
    logActionFailure("currentCascades", error);
    return null;
  }
}

/**
 * Ask the runner for a `manual` cycle. `rawPayload` is untrusted. An open request is reused only when it covers this one
 * (every channel, or a superset of the channels asked for; a LinkedIn fallback source only when that request would lead
 * the cascade with it, see `cycleCovers`); otherwise a new request is queued, which the runner's serial poller takes up
 * after the open one, so a click for one channel never swallows the click for another.
 * A backfill must fit the configured limit and requires no queued or running cycle request; it is never reused. A config file
 * that cannot be read refuses a backfill with `configUnavailable` (the limit is unknown). The open requests are read and the new
 * one inserted under one lock (`queueRunCycleRequest`), so two requests at once cannot both pass the busy check.
 */
export async function requestRunCycle(rawPayload: unknown): Promise<ControlActionState> {
  const payload = runCyclePayloadSchema.safeParse(rawPayload ?? {});
  if (!payload.success) return fail("invalidPayload");
  if (payload.data.channelIds?.some((id) => !isConfiguredChannelId(id))) return fail("unknownChannel");
  const backfillHours = payload.data.backfillHours;
  if (backfillHours !== undefined) {
    let maxBackfillHours: number;
    try {
      maxBackfillHours = loadConfig("channels").collect.max_backfill_hours;
    } catch (error) {
      logActionFailure("requestRunCycle.config", error);
      return fail("configUnavailable");
    }
    if (backfillHours > maxBackfillHours) return { status: "error", error: "backfillOverLimit", maxBackfillHours, nonce: Date.now() };
  }
  // without the cascades nothing can be judged covered: queue a request of its own
  const cascades = backfillHours === undefined ? currentCascades() : null;
  try {
    const outcome = await queueRunCycleRequest(getDb(), {
      payload: payload.data,
      exclusive: backfillHours !== undefined,
      reuse: (open) => cascades === null ? undefined : open.find((row) => {
        const stored = runCyclePayloadSchema.safeParse(row.payload ?? {});
        return stored.success && cycleCovers(stored.data.channelIds, payload.data.channelIds, cascades);
      }),
    });
    if (outcome.state === "busy") return fail("cycleBusy");
    if (outcome.state === "existing") return queued(outcome.row, true);
    log.info("manual request queued", { request: outcome.row.id, kind: outcome.row.kind, channels: payload.data.channelIds?.join(",") ?? "all", ...(backfillHours === undefined ? {} : { backfillHours }) });
    return queued(outcome.row, false);
  } catch (error) {
    logActionFailure("requestRunCycle", error);
    return fail("databaseUnavailable");
  }
}

/** Ask the runner to re-score postings whose score is stale. Refused when nothing is stale. */
export async function requestRescoreStale(): Promise<ControlActionState> {
  try {
    const db = getDb();
    const open = await findOpenControlRequest(db, "rescore_stale");
    if (open) return queued(open, true);
    if ((await countStaleScores(db)) === 0) return fail("nothingStale");
    return queued(await insertControlRequest(db, { kind: "rescore_stale" }), false);
  } catch (error) {
    logActionFailure("requestRescoreStale", error);
    return fail("databaseUnavailable");
  }
}

const sameScorePayload = (a: ScoreJobsPayload, b: ScoreJobsPayload): boolean => {
  if ("backlog" in a || "backlog" in b) return "backlog" in a && "backlog" in b;
  const left = new Set(a.jobIds);
  return left.size === new Set(b.jobIds).size && b.jobIds.every((id) => left.has(id));
};

/**
 * Ask the runner to score postings now: `{ jobIds }` the named ones (the "score now" button of a
 * job), `{ backlog: true }` the jobs that wait for a first score (the settings button). `rawPayload` is
 * untrusted. An open request with the same payload is reused, but a request for another job is its own:
 * scoring one job must not swallow the click on the next. Refused when there is nothing to score.
 */
export async function requestScoreJobs(rawPayload: unknown): Promise<ControlActionState> {
  const payload = scoreJobsPayloadSchema.safeParse(rawPayload);
  if (!payload.success) return fail("invalidPayload");
  try {
    const db = getDb();
    const open = (await listOpenControlRequests(db, "score_jobs")).find((row) => {
      const parsed = scoreJobsPayloadSchema.safeParse(row.payload);
      return parsed.success && sameScorePayload(parsed.data, payload.data);
    });
    if (open) return queued(open, true);
    if ("backlog" in payload.data) {
      if ((await countUnscoredJobs(db)) === 0) return fail("nothingToScore");
    } else {
      const waiting = await Promise.all(payload.data.jobIds.map((id) => jobWaitsForScore(db, id)));
      if (!waiting.some(Boolean)) return fail("nothingToScore");
    }
    return queued(await insertControlRequest(db, { kind: "score_jobs", payload: payload.data }), false);
  } catch (error) {
    logActionFailure("requestScoreJobs", error);
    return fail("databaseUnavailable");
  }
}

// ---------------------------------------------------------------- the test buttons

/** How many recent requests of a kind are looked at for "the same request" (reuse, rate limit). */
const RECENT_FOR_SAME = 20;

/**
 * Leave a test request: an open request for the same target is reused; one that finished less than
 * `schedule.yaml: manual_triggers.min_interval_seconds` ago blocks a new one (`tooSoon`). Every request made is logged.
 */
async function requestTest(db: Db, kind: ControlRequestKind, payload: Record<string, unknown>, same: (stored: unknown) => boolean): Promise<ControlActionState> {
  const recent = (await listControlRequests(db, RECENT_FOR_SAME, [kind])).filter((row) => same(row.payload));
  const open = recent.find((row) => (OPEN_CONTROL_STATUSES as readonly string[]).includes(row.status));
  if (open) return queued(open, true);
  const latest = recent[0];
  const minIntervalMs = loadConfig("schedule").manual_triggers.min_interval_seconds * 1000;
  if (latest && minIntervalMs > 0) {
    const since = (await getDbNow(db)).getTime() - (latest.finishedAt ?? latest.requestedAt).getTime();
    if (since < minIntervalMs) return { status: "error", error: "tooSoon", nonce: Date.now(), retryAfterSeconds: Math.max(1, Math.ceil((minIntervalMs - since) / 1000)) };
  }
  const row = await insertControlRequest(db, { kind, payload });
  log.info("manual request queued", { request: row.id, kind, ...payload });
  return queued(row, false);
}

/** "Test" of a channel on /sources: one small dry fetch by the runner. `rawPayload` is untrusted. */
export async function requestTestChannel(rawPayload: unknown): Promise<ControlActionState> {
  const payload = testChannelPayloadSchema.safeParse(rawPayload);
  if (!payload.success) return fail("invalidPayload");
  if (!isConfiguredChannelId(payload.data.channelId)) return fail("unknownChannel");
  const { channelId } = payload.data;
  try {
    return await requestTest(getDb(), "test_channel", { channelId }, (stored) => testChannelPayloadSchema.safeParse(stored).data?.channelId === channelId);
  } catch (error) {
    logActionFailure("requestTestChannel", error);
    return fail("databaseUnavailable");
  }
}

/** "Test" of an AI provider on /sources: one tiny probe call by the ai-worker. `rawPayload` is untrusted. */
export async function requestTestAi(rawPayload: unknown): Promise<ControlActionState> {
  const payload = testAiPayloadSchema.safeParse(rawPayload);
  if (!payload.success) return fail("invalidPayload");
  const { provider } = payload.data;
  try {
    return await requestTest(getDb(), "test_ai", { provider }, (stored) => testAiPayloadSchema.safeParse(stored).data?.provider === provider);
  } catch (error) {
    logActionFailure("requestTestAi", error);
    return fail("databaseUnavailable");
  }
}

/** "Send a Telegram test message" on /settings (the page asks for a confirmation first). */
export async function requestTestTelegram(): Promise<ControlActionState> {
  try {
    return await requestTest(getDb(), "test_telegram", {}, () => true);
  } catch (error) {
    logActionFailure("requestTestTelegram", error);
    return fail("databaseUnavailable");
  }
}
