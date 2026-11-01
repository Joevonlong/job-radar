"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ConfigError, reloadConfig, type AiConfig } from "@/lib/config";
import { readSalaryLookupRequest, requestSalaryLookup } from "@/lib/control/salary-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { getDb } from "@/lib/db";
import { countSalaryLookupRequests, getJobForSalaryLookup } from "@/lib/db/repos/salary-lookups";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey, type SalaryErrorCode } from "@/lib/salary/lookup";
import { readSalarySettings } from "@/lib/salary/settings";

/**
 * Server Actions of the salary lookup in the salary panel. Like the breakdown button: the web app calls no AI provider;
 * it leaves a `salary_lookup` request for the ai-worker and the card polls `salaryLookupStatusAction`. Input is validated (C6).
 */

const jobIdSchema = z.number().int().positive();
const lookupInputSchema = z.object({ jobId: jobIdSchema, force: z.boolean().optional() });
const statusInputSchema = z.object({ jobId: jobIdSchema, requestId: z.number().int().positive() });

export type SalaryActionErrorKey = "invalid" | "not_ready" | SalaryErrorCode;

export type SalaryLookupActionResult =
  /** A current cached lookup exists: the card refreshes the page. */
  | { ok: true; queued: false }
  /** `usedToday`: the lookups of the last 24 hours now, this one included (the card's counter). */
  | { ok: true; queued: true; requestId: number; usedToday: number }
  | { ok: false; error: SalaryActionErrorKey };

export type SalaryLookupStatusResult =
  /** The state could not be read this time; the browser retries. */
  | null
  /** `queue`: where the request stands (position, what the worker is doing, whether it is alive). */
  | { ok: true; state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { ok: true; state: "done" }
  | { ok: false; error: SalaryActionErrorKey; detail?: string | null; resumeAt?: string | null };

function readAi(): AiConfig | null {
  try {
    return reloadConfig("ai");
  } catch (error) {
    logActionFailure("readAi", error);
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** Look up a job's salary (the button in the salary panel): queue the request, or report that a current lookup exists. */
export async function lookupSalaryAction(input: { jobId: number; force?: boolean }): Promise<SalaryLookupActionResult> {
  const parsed = lookupInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const settings = readSalarySettings();
    const db = getDb();
    const outcome = await requestSalaryLookup(db, { jobId: parsed.data.jobId, force: parsed.data.force ?? false, salary: settings.state === "ok" ? settings.config : null, ai: readAi() });
    if (outcome.state === "error") return { ok: false, error: outcome.error };
    if (outcome.state === "cached") return { ok: true, queued: false };
    return { ok: true, queued: true, requestId: outcome.requestId, usedToday: await countSalaryLookupRequests(db, new Date()) };
  } catch (error) {
    logActionFailure("lookupSalaryAction", error);
    return { ok: false, error: "failed" };
  }
}

/** State of a queued lookup: still waiting, done (the page is revalidated), or the reason it failed. */
export async function salaryLookupStatusAction(input: { jobId: number; requestId: number }): Promise<SalaryLookupStatusResult> {
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    const settings = readSalarySettings();
    const job = settings.state === "ok" ? await getJobForSalaryLookup(db, parsed.data.jobId) : null;
    const lookupKey = job && settings.state === "ok" ? salaryLookupKey(job, compileFamilies(settings.config.role_families).familyOf(job.title)) : undefined;
    const state = await readSalaryLookupRequest(db, { ...parsed.data, ...(lookupKey ? { lookupKey } : {}) });
    if (state.state === "missing") return { ok: false, error: "not_found" };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, detail: state.detail, resumeAt: state.resumeAt };
    revalidatePath(`/jobs/${parsed.data.jobId}`);
    return { ok: true, state: "done" };
  } catch (error) {
    logActionFailure("salaryLookupStatusAction", error);
    return null;
  }
}
