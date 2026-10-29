import { z } from "zod";

import { AI_PROVIDER_IDS } from "@/lib/ai/types";
import type { ChannelLogger } from "@/lib/channels/types";
import type { Db } from "@/lib/db/client";
import type { CycleSummary } from "@/lib/cycle/run-cycle";
import type { ControlRequest } from "@/lib/db/repos/control-requests";

/** Payload of a `run_cycle` request: run only these channels (default: every enabled channel). */
export const runCyclePayloadSchema = z.strictObject({
  channelIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
});
export type RunCyclePayload = z.infer<typeof runCyclePayloadSchema>;

/** Payload of a `rescore_stale` request (nothing yet). */
export const rescorePayloadSchema = z.strictObject({});

/** Payload of a `run_ai` request: the cycle whose `ai` and `notify` steps were delegated to the ai-worker. */
export const runAiPayloadSchema = z.strictObject({
  cycleId: z.number().int().positive(),
});
export type RunAiPayload = z.infer<typeof runAiPayloadSchema>;

/** Payload of a `translate_job` request (the translate button on the job page). */
export const translateJobPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  /** Only automatic follow-up translations write this marker; web requests keep the legacy payload. */
  origin: z.literal("auto").optional(),
  /** Translate again although a current translation exists (the "outdated" case). */
  force: z.boolean().default(false),
});
export type TranslateJobPayload = z.infer<typeof translateJobPayloadSchema>;

/** Payload of a `breakdown_job` request (the breakdown button on the job page). */
export const breakdownJobPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  /** Break down again although a current breakdown exists. */
  force: z.boolean().default(false),
});
export type BreakdownJobPayload = z.infer<typeof breakdownJobPayloadSchema>;

/** Payload of a `salary_lookup` request (the "look up salary" button on the job page). */
export const salaryLookupPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  /** Look up again although a current cached lookup exists. */
  force: z.boolean().default(false),
  /** The cache key at queue time (only to join a double click; the worker works the key out again). */
  lookupKey: z.string().max(600).optional(),
});
export type SalaryLookupPayload = z.infer<typeof salaryLookupPayloadSchema>;

/** The most jobs one `score_jobs` request may name (the buttons send one; this only bounds a hand-made request). */
export const SCORE_JOBS_MAX_IDS = 50;

/** Payload of a `score_jobs` request: score exactly these jobs, or the waiting backlog (up to `scoring.backlog_per_run`). */
export const scoreJobsPayloadSchema = z.union([
  z.strictObject({ jobIds: z.array(z.number().int().positive()).min(1).max(SCORE_JOBS_MAX_IDS) }),
  z.strictObject({ backlog: z.literal(true) }),
]);
export type ScoreJobsPayload = z.infer<typeof scoreJobsPayloadSchema>;

/** Payload of a `test_channel` request: one small dry fetch of this channel. */
export const testChannelPayloadSchema = z.strictObject({
  channelId: z.string().trim().min(1).max(64),
});
export type TestChannelPayload = z.infer<typeof testChannelPayloadSchema>;

/** Payload of a `test_ai` request: one tiny probe call to this provider. */
export const testAiPayloadSchema = z.strictObject({
  provider: z.enum(AI_PROVIDER_IDS),
});
export type TestAiPayload = z.infer<typeof testAiPayloadSchema>;

/** Payload of a `test_telegram` request: nothing. */
export const testTelegramPayloadSchema = z.strictObject({});

/** What the runner passes to a handler. */
export interface ControlHandlerContext {
  db: Db;
  /** Aborted when the runner shuts down. */
  signal: AbortSignal;
  logger: ChannelLogger;
  /** Non-blocking maintenance owned by the runner after a manual cycle. */
  onCycleFinished?: (summary: CycleSummary) => void;
}

/** What a handler reports; stored in `control_requests.result` (JSON, shown on the settings page). */
export interface ControlOutcome {
  status: "done" | "failed";
  result: Record<string, unknown>;
}

export type ControlHandler = (request: ControlRequest, context: ControlHandlerContext) => Promise<ControlOutcome>;
