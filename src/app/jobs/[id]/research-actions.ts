"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ConfigError, reloadConfig, type AiConfig } from "@/lib/config";
import { readCompanyResearchRequest, requestCompanyResearch } from "@/lib/control/company-research-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { getDb } from "@/lib/db";
import { countCompanyResearchRequests, getJobForCompanyResearch } from "@/lib/db/repos/company-research";
import type { CompanyResearchErrorCode } from "@/lib/research/company";
import { readResearchSettings } from "@/lib/research/settings";

/**
 * Server Actions of the company background panel. Like the salary lookup: the web app calls no AI provider; it leaves a
 * `company_research` request for the ai-worker and the panel polls `companyResearchStatusAction`. Input is validated (C6).
 */

const jobIdSchema = z.number().int().positive();
const requestInputSchema = z.object({ jobId: jobIdSchema, force: z.boolean().optional() });
const statusInputSchema = z.object({ jobId: jobIdSchema, requestId: z.number().int().positive() });

export type CompanyResearchActionErrorKey = "invalid" | "not_ready" | CompanyResearchErrorCode;

export type CompanyResearchActionResult =
  /** A current cached result exists: the panel refreshes the page. */
  | { ok: true; queued: false }
  /** `usedToday`: the lookups of the last 24 hours now, this one included (the panel's counter). */
  | { ok: true; queued: true; requestId: number; usedToday: number }
  | { ok: false; error: CompanyResearchActionErrorKey };

export type CompanyResearchStatusResult =
  /** The state could not be read this time; the browser retries. */
  | null
  /** `queue`: where the request stands (position, what the worker is doing, whether it is alive). */
  | { ok: true; state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { ok: true; state: "done" }
  | { ok: false; error: CompanyResearchActionErrorKey; detail?: string | null; resumeAt?: string | null };

function readAi(): AiConfig | null {
  try {
    return reloadConfig("ai");
  } catch (error) {
    logActionFailure("readAi", error);
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** Look up a job's company (the button in the panel): queue the request, or report that a current result exists. */
export async function requestCompanyResearchAction(input: { jobId: number; force?: boolean }): Promise<CompanyResearchActionResult> {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const settings = readResearchSettings();
    const db = getDb();
    const outcome = await requestCompanyResearch(db, { jobId: parsed.data.jobId, force: parsed.data.force ?? false, research: settings.state === "ok" ? settings.config : null, ai: readAi() });
    if (outcome.state === "error") return { ok: false, error: outcome.error };
    if (outcome.state === "cached") return { ok: true, queued: false };
    return { ok: true, queued: true, requestId: outcome.requestId, usedToday: await countCompanyResearchRequests(db, new Date()) };
  } catch (error) {
    logActionFailure("requestCompanyResearchAction", error);
    return { ok: false, error: "failed" };
  }
}

/** State of a queued lookup: still waiting, done (the page is revalidated), or the reason it failed. */
export async function companyResearchStatusAction(input: { jobId: number; requestId: number }): Promise<CompanyResearchStatusResult> {
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    const job = await getJobForCompanyResearch(db, parsed.data.jobId);
    const state = await readCompanyResearchRequest(db, { ...parsed.data, ...(job ? { companyId: job.companyId } : {}) });
    if (state.state === "missing") return { ok: false, error: "not_found" };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, detail: state.detail, resumeAt: state.resumeAt };
    revalidatePath(`/jobs/${parsed.data.jobId}`);
    return { ok: true, state: "done" };
  } catch (error) {
    logActionFailure("companyResearchStatusAction", error);
    return null;
  }
}
