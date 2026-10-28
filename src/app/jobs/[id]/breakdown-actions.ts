"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { readBreakdownSettings } from "@/lib/breakdown/settings";
import { readBreakdownRequest, requestBreakdownJob, type BreakdownErrorCode } from "@/lib/control/breakdown-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { getDb } from "@/lib/db";

/**
 * Server Actions of the breakdown card. Like the translate button: the web app calls no AI provider; it
 * leaves a `breakdown_job` request for the ai-worker and the card polls `breakdownStatusAction`. Input is validated (C6).
 */

const jobIdSchema = z.number().int().positive();
const jobInputSchema = z.object({ jobId: jobIdSchema, force: z.boolean().optional() });
const statusInputSchema = z.object({ jobId: jobIdSchema, requestId: z.number().int().positive() });

export type BreakdownErrorKey = "invalid" | BreakdownErrorCode;

export type BreakdownActionResult =
  /** Already current: the card refreshes the page. */
  | { ok: true; queued: false }
  | { ok: true; queued: true; requestId: number }
  | { ok: false; error: BreakdownErrorKey };

export type BreakdownStatusResult =
  /** The state could not be read this time; the browser retries. */
  | null
  /** `queue`: where the request stands (position, what the worker is doing, whether it is alive). */
  | { ok: true; state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { ok: true; state: "done" }
  | { ok: false; error: BreakdownErrorKey; detail?: string | null; resumeAt?: string | null };

/** Break a job's JD down (the button on the breakdown card): queue the request, or report that a current result exists. */
export async function breakdownJobAction(input: { jobId: number; force?: boolean }): Promise<BreakdownActionResult> {
  const parsed = jobInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const outcome = await requestBreakdownJob(getDb(), { jobId: parsed.data.jobId, force: parsed.data.force ?? false, settings: readBreakdownSettings() });
    if (outcome.state === "error") return { ok: false, error: outcome.error };
    if (outcome.state === "cached") return { ok: true, queued: false };
    return { ok: true, queued: true, requestId: outcome.requestId };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** State of a queued breakdown: still waiting, done (the page is revalidated), or the reason it failed. */
export async function breakdownStatusAction(input: { jobId: number; requestId: number }): Promise<BreakdownStatusResult> {
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const state = await readBreakdownRequest(getDb(), parsed.data);
    if (state.state === "missing") return { ok: false, error: "not_found" };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, detail: state.detail, resumeAt: state.resumeAt };
    revalidatePath(`/jobs/${parsed.data.jobId}`);
    return { ok: true, state: "done" };
  } catch {
    return null;
  }
}
