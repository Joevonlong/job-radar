/**
 * The company background (ai-worker side). Only public facts go out: the company name and a website domain the user
 * confirmed (C5: never a title, a place, the JD, the profile or a domain inferred from postings). The provider searches the
 * web (one of the tasks allowed to, `web-tasks.ts`); the answer is checked in code (`verify.ts`) and stored in
 * `company_research` (C3: an estimate with sources, never a fact of the company).
 */
import { AiProviderError } from "@/lib/ai/errors";
import { buildCompanyResearchPrompt, companyResearchOutputSchema, COMPANY_RESEARCH_PROMPT_VERSION } from "@/lib/ai/prompts/company-research";
import type { AiRouter } from "@/lib/ai/router";
import { publicWebsiteDomains, webAccessAllowed, webLimits } from "@/lib/ai/web-tasks";
import type { ChannelLogger } from "@/lib/channels/types";
import type { ResearchConfig } from "@/lib/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Db } from "@/lib/db/client";
import { companyResearchCurrent, confirmedWebsiteDomain, findLatestCompanyResearch, getJobForCompanyResearch, insertCompanyResearch } from "@/lib/db/repos/company-research";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";

import { verifyCompanyResearch } from "./verify";

/** Error codes the panel has labels for: the AI failure classes (as for translations) plus the request-level ones. */
export const COMPANY_RESEARCH_ERROR_CODES = [...TRANSLATION_FAILURE_CODES, "disabled", "research_disabled", "config_error", "not_found", "no_web_provider", "quota", "empty_result", "aborted", "invalid_payload", "handler_error", "no_handler"] as const;
export type CompanyResearchErrorCode = (typeof COMPANY_RESEARCH_ERROR_CODES)[number];

export type CompanyResearchOutcome =
  | { status: "done"; cached: boolean; researchId: number; provider: string | null; model: string | null; fields: number; dropped: number }
  | { status: "failed"; error: CompanyResearchErrorCode; detail?: string };

export interface CompanyResearchRunOptions {
  force: boolean;
  config: ResearchConfig;
  traps: TrapsConfig;
  signal?: AbortSignal;
  logger?: ChannelLogger;
  now?: () => Date;
}

/**
 * Research the company of one job. The whole lookup (every provider, the validation retry) shares one deadline
 * (`company.timeout_seconds`) and one search budget (`company.max_searches`).
 */
export async function runCompanyResearch(db: Db, router: AiRouter, jobId: number, opts: CompanyResearchRunOptions): Promise<CompanyResearchOutcome> {
  const now = opts.now ?? (() => new Date());
  const { company } = opts.config;
  if (!opts.config.enabled) return { status: "failed", error: "disabled" };
  const job = await getJobForCompanyResearch(db, jobId);
  if (!job) return { status: "failed", error: "not_found" };
  const confirmedDomain = confirmedWebsiteDomain(job);

  if (!opts.force) {
    const latest = await findLatestCompanyResearch(db, { companyId: job.companyId, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, now: now() });
    if (latest && companyResearchCurrent(latest, confirmedDomain)) {
      return { status: "done", cached: true, researchId: latest.id, provider: latest.provider, model: latest.model, fields: Object.keys(latest.fields).length, dropped: latest.dropped };
    }
  }
  // the policy check of the worker side: the task may reach the web, and at least one provider of its plan can
  const plan = router.plan("company_research");
  if (!plan.some((provider) => webAccessAllowed("company_research", provider))) return { status: "failed", error: "no_web_provider" };

  const limits = webLimits(publicWebsiteDomains([...company.allowed_domains, ...(confirmedDomain !== null ? [confirmedDomain] : [])]), company.max_searches);
  const prompt = buildCompanyResearchPrompt({ company: job.company, confirmedDomain, maxSearches: company.max_searches });
  const deadline = AbortSignal.timeout(company.timeout_seconds * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let result;
  try {
    result = await router.run("company_research", prompt, companyResearchOutputSchema, {
      jobId,
      signal,
      timeoutMs: company.timeout_seconds * 1000,
      requireWeb: true,
      web: limits,
      webSearchCostUsd: company.web_search_usd,
    });
  } catch (error) {
    if (error instanceof AiProviderError && error.kind === "aborted") {
      return { status: "failed", error: deadline.aborted && !opts.signal?.aborted ? "timeout" : "aborted" };
    }
    throw error;
  }
  const verified = verifyCompanyResearch({ output: result.value, limits: company, traps: opts.traps, now: now() });
  const kept = Object.keys(verified.fields).length;
  const fetchedAt = now();
  const base = { companyId: job.companyId, jobId, domainUsed: confirmedDomain, provider: result.provider, model: result.model, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, fetchedAt };
  if (kept === 0) {
    // nothing usable, and never half a result: the failed row is no cache, the next lookup searches again
    await insertCompanyResearch(db, { ...base, status: "failed", errorCode: "empty_result" });
    opts.logger?.info("company research came back empty", { jobId, provider: result.provider, model: result.model, dropped: verified.dropped });
    return { status: "failed", error: "empty_result" };
  }
  const researchId = await insertCompanyResearch(db, { ...base, status: "ok", result: verified, expiresAt: new Date(fetchedAt.getTime() + company.ttl_days * 86_400_000) });
  opts.logger?.info("company researched", { jobId, provider: result.provider, model: result.model, fields: kept, dropped: verified.dropped });
  return { status: "done", cached: false, researchId, provider: result.provider, model: result.model, fields: kept, dropped: verified.dropped };
}
