import type { ActivityRecorder, RequestSpanHandle } from "@/lib/activity/types";
import { z } from "zod";

import { MODEL_SYNC_PROVIDERS } from "@/lib/ai/model-sync/types";
import { AI_PROVIDER_IDS } from "@/lib/ai/types";
import type { ChannelLogger } from "@/lib/channels/types";
import { MAX_WINDOW_HOURS } from "@/lib/config/schemas/channels";
import type { Db } from "@/lib/db/client";
import type { CycleSummary } from "@/lib/cycle/run-cycle";
import type { ControlRequest } from "@/lib/db/repos/control-requests";
import { STORY_EXTRACT_MAX_CHARS, STORY_EXTRACT_ORIGINS } from "@/lib/stories/extract";
import { companySnapshotSchema, storySnapshotSchema, writerMaterialsSchema } from "@/lib/writer/materials";
import { POLISH_OPTIONS, WRITE_MODES } from "@/lib/writer/types";

/** Payload of a `run_cycle` request: run only these channels (default: every enabled channel). */
export const runCyclePayloadSchema = z.strictObject({
  channelIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
  /** Only the hard bound; requestRunCycle and runCycleHandler check the configured max_backfill_hours. */
  backfillHours: z.number().int().min(1).max(MAX_WINDOW_HOURS).optional(),
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

/**
 * Payload of a `writer_job` request (the application writer's "write", "improve my draft" and coach buttons). `materials`
 * is the snapshot of what the user chose and, to polish or review, the text to work on (`draft`), written from and checked against; it is removed from the row (`scrubbed: true`) as soon as the request
 * ends in any way. `refs` and `materialsHash` stay: which stories and how many JD points were used, never their text.
 */
export const writerJobPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  questionId: z.number().int().positive(),
  /** What the request does; absent in a request queued before the other modes existed (a draft). */
  mode: z.enum(WRITE_MODES).default("draft"),
  /** `polish`: how. */
  polish: z.enum(POLISH_OPTIONS).optional(),
  /** `coach` / `coach_rewrite`: the version under review (its text is in `materials.draft`). */
  versionId: z.number().int().positive().optional(),
  materialsHash: z.string().regex(/^[0-9a-f]{64}$/),
  refs: z.strictObject({
    storyIds: z.array(z.string().max(80)).max(1000),
    jdPoints: z.number().int().min(0),
    profile: z.boolean(),
    emphasis: z.boolean(),
    draft: z.boolean().default(false),
    companyResearchId: z.number().int().positive().nullable().default(null),
  }),
  materials: writerMaterialsSchema,
});
export type WriterJobPayload = z.infer<typeof writerJobPayloadSchema>;

/**
 * Payload of a `story_extract` request (the "from profile", "paste" and "upload" entries of the stories card). `text` is the
 * source, cleared by every path that ends the request (`SCRUBBED_PAYLOAD_KEYS`); the hash and length stay. An `origin`
 * value here also means the interactive lane: only `"auto"` means batch.
 */
export const storyExtractPayloadSchema = z.strictObject({
  origin: z.enum(STORY_EXTRACT_ORIGINS),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceChars: z.number().int().min(0),
  truncated: z.boolean(),
  text: z.string().min(1).max(STORY_EXTRACT_MAX_CHARS),
});
export type StoryExtractPayload = z.infer<typeof storyExtractPayloadSchema>;

/**
 * Payload of a `writer_fit` request (the "what this means for your application" button). `materials` holds the ticked company
 * background and the chosen stories and is removed when the request ends, like a `writer_job`'s.
 */
export const writerFitPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  questionId: z.number().int().positive(),
  materialsHash: z.string().regex(/^[0-9a-f]{64}$/),
  refs: z.strictObject({ storyIds: z.array(z.string().max(80)).max(1000), companyResearchId: z.number().int().positive() }),
  materials: z.strictObject({
    job: z.strictObject({ title: z.string().max(1000), company: z.string().max(1000) }),
    outputLanguage: z.string().min(2).max(35),
    stories: z.array(storySnapshotSchema).min(1).max(1000),
    company: companySnapshotSchema,
  }),
});
export type WriterFitPayload = z.infer<typeof writerFitPayloadSchema>;

/** Payload of a `salary_lookup` request (the "look up salary" button on the job page). */
export const salaryLookupPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  /** Look up again although a current cached lookup exists. */
  force: z.boolean().default(false),
  /** The cache key at queue time (only to join a double click; the worker works the key out again). */
  lookupKey: z.string().max(600).optional(),
});
export type SalaryLookupPayload = z.infer<typeof salaryLookupPayloadSchema>;

/** Payload of a `company_research` request (the "look up company" button on the job page). */
export const companyResearchPayloadSchema = z.strictObject({
  jobId: z.number().int().positive(),
  /** The company at queue time: joins a double click and other postings of the same company. The worker reads the job's company again. */
  companyId: z.number().int().positive(),
  /** Look up again although a current cached result exists. */
  force: z.boolean().default(false),
  /** Only automatic research writes this marker: it keeps the request in the batch lane and out of the manual quota. */
  origin: z.literal("auto").optional(),
});
export type CompanyResearchPayload = z.infer<typeof companyResearchPayloadSchema>;

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

/** Payload of a `models_sync` request: refresh this provider's model list; nothing else is accepted (no URL, no path). */
export const modelsSyncPayloadSchema = z.strictObject({
  provider: z.enum(MODEL_SYNC_PROVIDERS),
  /** Shows only the models whose id or name contains this (case-insensitive). */
  filter: z.string().trim().min(1).max(80).optional(),
});
export type ModelsSyncPayload = z.infer<typeof modelsSyncPayloadSchema>;

/** Payload of a `test_telegram` request: nothing. */
export const testTelegramPayloadSchema = z.strictObject({});

/** What the runner passes to a handler. */
export interface ControlHandlerContext {
  activity?: RequestSpanHandle;
  recorder?: ActivityRecorder;
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
