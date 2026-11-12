import { z } from "zod";

import { SAFE_ERROR_CODES, safeErrorCode } from "@/lib/activity/error-codes";
import { AGENT_ACTIONS } from "@/lib/config/schemas/mcp";
import { SCORING_STOPPED_VALUES } from "@/lib/control/request-view-schema";

const count = z.number().int().nonnegative();
const iso = z.iso.datetime();

export const actionOutput = z.strictObject({
  request_id: z.number().int().positive().nullable(),
  state: z.enum(["queued", "joined_existing", "cached"]),
  existing: z.boolean(),
  budget: z.strictObject({ action: z.enum(AGENT_ACTIONS), remaining: count, resets_at: iso }),
  notices: z.array(z.string()),
});
export type ActionOutput = z.infer<typeof actionOutput>;

export const requestSummaryDto = z.strictObject({
  error: z.enum([...SAFE_ERROR_CODES, "other"]).optional(),
  resume_at: iso.nullable().optional(),
  scored: count.optional(),
  failed: count.optional(),
  remaining: count.optional(),
  fetched: count.optional(),
  new: count.optional(),
  stopped: z.enum(SCORING_STOPPED_VALUES).optional(),
});

const storedSummary = z.object({
  error: z.unknown().optional(),
  resumeAt: iso.nullable().optional().catch(undefined),
  scored: count.optional().catch(undefined),
  failed: count.optional().catch(undefined),
  remaining: count.optional().catch(undefined),
  fetched: count.optional().catch(undefined),
  new: count.optional().catch(undefined),
  stopped: z.enum(SCORING_STOPPED_VALUES).optional().catch(undefined),
});

/** Only machine codes and counts cross the boundary, even if a worker stored free text in an error field. */
export function toRequestSummary(value: unknown): z.infer<typeof requestSummaryDto> {
  const result = storedSummary.safeParse(value).data ?? {};
  return requestSummaryDto.parse({
    error: result.error === undefined ? undefined : safeErrorCode(result.error),
    resume_at: result.resumeAt,
    scored: result.scored,
    failed: result.failed,
    remaining: result.remaining,
    fetched: result.fetched,
    new: result.new,
    stopped: result.stopped,
  });
}

export const requestStatusOutput = z.strictObject({
  request_id: z.number().int().positive(),
  status: z.enum(["pending", "running", "done", "failed"]),
  ahead: count.nullable(),
  worker_online: z.boolean().nullable(),
  requested_at: iso,
  started_at: iso.nullable(),
  finished_at: iso.nullable(),
  result: requestSummaryDto,
  cycle: z.strictObject({
    id: z.number().int().positive(),
    status: z.enum(["running", "succeeded", "partial", "failed", "skipped"]),
    runs_total: count,
    runs_finished: count,
    fetched: count,
    new: count,
  }).nullable(),
  notices: z.array(z.string()),
});
export type RequestStatusOutput = z.infer<typeof requestStatusOutput>;
