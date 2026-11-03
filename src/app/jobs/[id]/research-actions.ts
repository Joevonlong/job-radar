"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isCompanyWebsiteCandidate } from "@/lib/ai/web-tasks";
import { ConfigError, reloadConfig, type AiConfig } from "@/lib/config";
import { readCompanyResearchRequest, requestCompanyResearch } from "@/lib/control/company-research-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { getDb } from "@/lib/db";
import { confirmInferredCompanyDomain, countCompanyResearchRequests, getJobForCompanyResearch, saveUserCompanyDomain } from "@/lib/db/repos/company-research";
import type { CompanyResearchErrorCode } from "@/lib/research/company";
import { registrableDomainOf } from "@/lib/research/domain";
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

const confirmDomainSchema = z.object({ companyId: z.number().int().positive(), domain: z.string().min(1).max(253) });
const saveDomainSchema = z.object({ companyId: z.number().int().positive(), domain: z.string().trim().min(1).max(2048) });

export type CompanyDomainActionResult = { ok: true; domain: string } | { ok: false; error: "invalid" | "invalid_domain" | "changed" | "config_error" | "failed" };

function afterDomainChange(): void {
  revalidatePath("/jobs/[id]", "page");
  revalidatePath("/companies");
}

/** The user confirms the domain inferred from the postings: from now on it may be sent and its pages opened. */
export async function confirmCompanyDomainAction(input: { companyId: number; domain: string }): Promise<CompanyDomainActionResult> {
  const parsed = confirmDomainSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const settings = readResearchSettings();
    if (settings.state !== "ok") return { ok: false, error: "config_error" };
    // the list may have changed since the domain was inferred: a host that is no company's own site is never confirmed
    if (!isCompanyWebsiteCandidate(parsed.data.domain, settings.config.company.non_company_hosts)) return { ok: false, error: "invalid_domain" };
    const confirmed = await confirmInferredCompanyDomain(getDb(), { ...parsed.data, now: new Date() });
    if (!confirmed) return { ok: false, error: "changed" };
    afterDomainChange();
    return { ok: true, domain: parsed.data.domain };
  } catch (error) {
    logActionFailure("confirmCompanyDomainAction", error);
    return { ok: false, error: "failed" };
  }
}

/** The user names the website: a pasted address is reduced to its domain, then checked here whatever the browser sent. */
export async function saveCompanyDomainAction(input: { companyId: number; domain: string }): Promise<CompanyDomainActionResult> {
  const parsed = saveDomainSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const settings = readResearchSettings();
    if (settings.state !== "ok") return { ok: false, error: "config_error" };
    const domain = registrableDomainOf(parsed.data.domain, settings.config.company.non_company_hosts);
    if (domain === null) return { ok: false, error: "invalid_domain" };
    const saved = await saveUserCompanyDomain(getDb(), { companyId: parsed.data.companyId, domain, now: new Date() });
    if (!saved) return { ok: false, error: "changed" };
    afterDomainChange();
    return { ok: true, domain };
  } catch (error) {
    logActionFailure("saveCompanyDomainAction", error);
    return { ok: false, error: "failed" };
  }
}
