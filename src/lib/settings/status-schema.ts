import { z } from "zod";

import { scoringStoppedSchema } from "@/lib/control/request-view-schema";

import { ACK_NAMES } from "./tabs";

/**
 * What `/api/control/status` returns and the settings page polls (a boundary, so it is parsed with
 * zod on the client too, C6). Dates are ISO strings.
 */
const iso = z.iso.datetime();

const cycleProgressSchema = z.object({
  id: z.number().int(),
  status: z.enum(["running", "succeeded", "partial", "failed", "skipped"]),
  startedAt: iso,
  finishedAt: iso.nullable(),
  runsTotal: z.number().int(),
  runsFinished: z.number().int(),
  fetched: z.number().int(),
  newCount: z.number().int(),
});

const requestSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["run_cycle", "rescore_stale", "run_suggest", "score_jobs"]),
  status: z.enum(["pending", "running", "done", "failed"]),
  requestedAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  channelIds: z.array(z.string()).nullable(),
  /** `score_jobs` for chosen jobs: which ones (null: not a `score_jobs` request, or the backlog). */
  jobIds: z.array(z.number().int()).nullable(),
  /** Machine-readable outcome (`error` is a code, never free text). */
  error: z.string().nullable(),
  /** Re-score outcome: postings scored / failed. */
  scored: z.number().int().nullable(),
  failed: z.number().int().nullable(),
  placeholder: z.boolean(),
  /** `error: "quota_guard"`: when Job Radar's AI usage cap is expected to let the AI work again (null = not known). */
  resumeAt: iso.nullable().optional(),
  /** Scoring requests: the postings still waiting afterwards. */
  remaining: z.number().int().nonnegative().optional().catch(undefined),
  /** `time_budget`: a scoring request that is done stopped at `ai.yaml: cycle_budget_minutes` (an unknown value reads as none). */
  stopped: scoringStoppedSchema,
  cycle: cycleProgressSchema.nullable(),
});

/** The AI part of a cycle that the ai-worker has not finished (a `run_ai` request that is open). */
const aiRunSchema = z.object({
  requestId: z.number().int(),
  status: z.enum(["pending", "running"]),
  cycleId: z.number().int().nullable(),
  /** Seconds since the worker took it, or since it was queued while it waits (measured with the database clock). */
  elapsedSeconds: z.number().int().nonnegative(),
  scored: z.number().int(),
  translated: z.number().int(),
});

const ackSchema = z.object({
  state: z.enum(["loaded", "waiting", "unknown"]),
  loadedAt: iso.nullable(),
});

export const controlStatusSchema = z.object({
  now: iso,
  heartbeat: z.object({ at: iso.nullable(), ageSeconds: z.number().int().nullable(), online: z.boolean() }),
  staleScores: z.number().int(),
  /** Passed jobs that never had an AI score (what "score the backlog" works through). */
  unscoredJobs: z.number().int(),
  /** What the runner last loaded, per config file it reads (see `ACK_NAMES`). */
  acks: z.partialRecord(z.enum(ACK_NAMES), ackSchema),
  /** Newest first. */
  requests: z.array(requestSchema),
  /** The AI part of a cycle that is queued or running on the ai-worker; null when there is none. */
  aiRun: aiRunSchema.nullable(),
});

export type ControlStatus = z.infer<typeof controlStatusSchema>;
export type ControlRequestView = z.infer<typeof requestSchema>;
export type ConfigAckView = z.infer<typeof ackSchema>;
export type AiRunView = z.infer<typeof aiRunSchema>;

/** True while something is still to happen: a request is open, or a saved file is not yet loaded by a live runner. */
export function statusNeedsPolling(status: ControlStatus): boolean {
  if (status.aiRun !== null) return true;
  if (status.requests.some((r) => r.status === "pending" || r.status === "running")) return true;
  return status.heartbeat.online && ACK_NAMES.some((name) => status.acks[name]?.state === "waiting");
}
