import { z } from "zod";

/**
 * One control request as the trigger buttons poll it from `/api/control/requests/<id>`: a boundary, so the
 * browser parses it with zod too (C6). Dates are ISO strings. `result` keeps only the machine-readable parts the page
 * shows (counts, codes, model names); free text never reaches it.
 */
const iso = z.iso.datetime();
const count = z.number().int().nonnegative();

export const requestResultViewSchema = z.object({
  /** Error code of a failed request (`another_cycle_running`, `channel_test_failed`, ...). */
  error: z.string().optional(),
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
  /** `quota_guard` failures: when Job Radar's AI usage cap is expected to let the AI work again (null = not known). */
  resumeAt: iso.nullable().optional().catch(undefined),
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
});

export type ControlRequestView = z.infer<typeof controlRequestViewSchema>;
export type RequestResultView = z.infer<typeof requestResultViewSchema>;

export function isOpenRequest(view: Pick<ControlRequestView, "status">): boolean {
  return view.status === "pending" || view.status === "running";
}

/** A stored `resumeAt` (ISO) as the pages use it; anything else is null. */
export function resumeAtOf(value: unknown): string | null {
  const parsed = iso.safeParse(value);
  return parsed.success ? parsed.data : null;
}
