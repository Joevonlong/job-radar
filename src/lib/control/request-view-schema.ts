import { z } from "zod";

/**
 * One control request as the trigger buttons poll it from `/api/control/requests/<id>`: a boundary, so the
 * browser parses it with zod too (C6). Dates are ISO strings. `result` keeps only the machine-readable parts the page
 * shows (counts, codes, model names); free text never reaches it.
 */
const iso = z.iso.datetime();
const count = z.number().int().nonnegative();

/** The processes that claim control requests (`runner_heartbeats.process`). */
export const CONTROL_PROCESSES = ["ai-worker", "runner"] as const;
export type ControlProcess = (typeof CONTROL_PROCESSES)[number];

/**
 * Where an unfinished request stands, as every waiting button shows it (`src/lib/control/queue-view.ts` builds it): how
 * many requests the claiming process takes first, what it is doing meanwhile, and whether that process is alive. `now` is
 * the database clock (for "running for N minutes"); `process` is null when no process claims the kind (shown as offline).
 */
export const controlQueueViewSchema = z.object({
  ahead: count,
  running: z.object({ kind: z.string(), since: iso }).nullable(),
  startedAt: iso.nullable(),
  now: iso,
  worker: z.object({
    process: z.enum(CONTROL_PROCESSES).nullable(),
    online: z.boolean(),
    heartbeatAgeSeconds: count.nullable(),
  }),
});
export type ControlQueueView = z.infer<typeof controlQueueViewSchema>;

/** Why a scoring request stopped early, including before the first score: the time budget ran out (an unknown value reads as none). */
export const SCORING_STOPPED_VALUES = ["time_budget"] as const;
export const scoringStoppedSchema = z.enum(SCORING_STOPPED_VALUES).optional().catch(undefined);

export const requestResultViewSchema = z.object({
  /** Error code of a failed request (`another_cycle_running`, `channel_test_failed`, ...). */
  error: z.string().optional(),
  /** Configured limit returned when a queued backfill is refused at execution. */
  maxBackfillHours: count.optional(),
  /** `test_channel`: the channel's error class (`network`, `blocked`, `timeout`, ...). */
  errorCode: z.string().optional(),
  /** `test_ai` / `test_telegram`: the provider's or the bot's error kind (`auth`, `rate_limited`, `network`, ...). */
  errorKind: z.string().optional(),
  fetched: count.optional(),
  parsed: count.optional(),
  parseFailed: count.optional(),
  sampleTitles: z.array(z.string()).optional(),
  durationMs: count.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  latencyMs: count.optional(),
  tokensIn: count.optional(),
  tokensOut: count.optional(),
  messageId: z.number().int().optional(),
  cycleId: z.number().int().nullable().optional(),
  cycleStatus: z.string().optional(),
  /** `run_cycle` done without a cycle of its own: the running cycle that covers its channels (also `cycleId`). */
  coveredBy: z.number().int().optional(),
  /** `quota_guard` failures: when Job Radar's AI usage cap is expected to let the AI work again (null = not known). */
  resumeAt: iso.nullable().optional().catch(undefined),
  /** `score_jobs`: postings scored / failed, and what still waits afterwards. */
  scored: count.optional().catch(undefined),
  failed: count.optional().catch(undefined),
  remaining: count.optional().catch(undefined),
  stopped: scoringStoppedSchema,
});

export const controlRequestViewSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]),
  requestedAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  result: requestResultViewSchema,
  /** `run_cycle`: the cycle it started, while it runs and after. */
  cycle: z
    .object({
      id: z.number().int(),
      status: z.enum(["running", "succeeded", "partial", "failed", "skipped"]),
      runsTotal: count,
      runsFinished: count,
      fetched: count,
      newCount: count,
    })
    .nullable(),
  /** While the request is pending or running: its place in the queue and the claiming process (null once it is finished). */
  queue: controlQueueViewSchema.nullable().default(null),
});

export type ControlRequestView = z.infer<typeof controlRequestViewSchema>;
export type RequestResultView = z.infer<typeof requestResultViewSchema>;

export function isOpenRequest(view: Pick<ControlRequestView, "status">): boolean {
  return view.status === "pending" || view.status === "running";
}

/** A `run_cycle` request done because a running cycle covers it, while that cycle still runs: its progress is still worth polling. */
export function followsCoveringCycle(view: Pick<ControlRequestView, "status" | "result" | "cycle">): boolean {
  return view.status === "done" && view.result.coveredBy !== undefined && view.cycle?.status === "running";
}

/** A stored `resumeAt` (ISO) as the pages use it; anything else is null. */
export function resumeAtOf(value: unknown): string | null {
  const parsed = iso.safeParse(value);
  return parsed.success ? parsed.data : null;
}
