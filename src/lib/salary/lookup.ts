/**
 * The on-demand salary lookup (ai-worker side). Only public facts of the posting go out: the company name, the
 * title, city, country and seniority (C5: never the profile, never the JD). The provider searches the web (the one task
 * allowed to, `web-tasks.ts`); the answer is checked in code (`lookup-verify.ts`) and stored in `salary_lookups` (C3:
 * an estimate with sources, never a fact of the job).
 */
import { AiProviderError } from "@/lib/ai/errors";
import { buildSalaryPrompt, salaryLookupOutputSchema, SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import type { AiRouter } from "@/lib/ai/router";
import { webAccessAllowed, webLimits } from "@/lib/ai/web-tasks";
import type { ChannelLogger } from "@/lib/channels/types";
import type { SalaryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { findLatestSalaryLookup, getJobForSalaryLookup, insertSalaryLookup } from "@/lib/db/repos/salary-lookups";
import type { FxTable } from "@/lib/market/currency";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";

import { compileFamilies } from "./families";
import { salaryLookupKey } from "./lookup-key";
import { verifySalaryLookup } from "./lookup-verify";
import type { SalaryLookupQuery } from "./lookup-types";

export { LOOKUP_KEY_MAX, salaryLookupKey } from "./lookup-key";

/** Error codes the salary panel has labels for: the AI failure classes (as for translations) plus the request-level ones. */
export const SALARY_ERROR_CODES = [...TRANSLATION_FAILURE_CODES, "disabled", "config_error", "not_found", "no_web_provider", "quota", "aborted", "invalid_payload", "handler_error", "no_handler"] as const;
export type SalaryErrorCode = (typeof SALARY_ERROR_CODES)[number];

export type SalaryLookupOutcome =
  | { status: "done"; cached: boolean; lookupId: number; provider: string | null; model: string | null; confidence: string; sources: number; dropped: number }
  | { status: "failed"; error: SalaryErrorCode; detail?: string };

export interface SalaryLookupRunOptions {
  force: boolean;
  config: SalaryConfig;
  currency: string;
  fx: FxTable;
  signal?: AbortSignal;
  logger?: ChannelLogger;
  now?: () => Date;
}

/**
 * Look one job's salary up. The whole lookup (every provider, the validation retry) shares one deadline
 * (`lookup.timeout_seconds`) and one search budget (`lookup.max_searches`).
 */
export async function runSalaryLookup(db: Db, router: AiRouter, jobId: number, opts: SalaryLookupRunOptions): Promise<SalaryLookupOutcome> {
  const now = opts.now ?? (() => new Date());
  const { lookup } = opts.config;
  if (!lookup.enabled) return { status: "failed", error: "disabled" };
  const job = await getJobForSalaryLookup(db, jobId);
  if (!job) return { status: "failed", error: "not_found" };
  const families = compileFamilies(opts.config.role_families);
  const family = families.familyOf(job.title);
  const lookupKey = salaryLookupKey(job, family);

  if (!opts.force) {
    const cached = await findLatestSalaryLookup(db, { lookupKey, promptVersion: SALARY_PROMPT_VERSION });
    if (cached && cached.expiresAt > now()) {
      return { status: "done", cached: true, lookupId: cached.id, provider: cached.provider, model: cached.model, confidence: cached.result.confidence, sources: cached.result.sources.length, dropped: cached.result.dropped };
    }
  }
  // the policy check of the worker side: the task may reach the web, and at least one provider of its plan can
  const plan = router.plan("salary_lookup");
  if (!plan.some((provider) => webAccessAllowed("salary_lookup", provider))) return { status: "failed", error: "no_web_provider" };

  const query: SalaryLookupQuery = {
    company: job.company,
    title: job.title,
    city: job.location?.city ?? null,
    country: job.location?.countryCode ?? null,
    seniority: job.seniority,
    currency: opts.currency,
  };
  const limits = webLimits(lookup.allowed_fetch_domains, lookup.max_searches);
  const prompt = buildSalaryPrompt({ ...query, maxSearches: lookup.max_searches, preferredDomains: limits.allowedDomains });
  const deadline = AbortSignal.timeout(lookup.timeout_seconds * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let result;
  try {
    result = await router.run("salary_lookup", prompt, salaryLookupOutputSchema, {
      jobId,
      signal,
      timeoutMs: lookup.timeout_seconds * 1000,
      requireWeb: true,
      web: limits,
      webSearchCostUsd: lookup.web_search_usd,
    });
  } catch (error) {
    if (error instanceof AiProviderError && error.kind === "aborted") {
      return { status: "failed", error: deadline.aborted && !opts.signal?.aborted ? "timeout" : "aborted" };
    }
    throw error;
  }
  const verified = verifySalaryLookup({
    output: result.value,
    query,
    fx: opts.fx,
    sanity: { ...lookup.sanity_annual, unconvertibleMax: lookup.unconvertible_max_annual },
    trustedDomains: limits.allowedDomains,
    familyOf: (title) => families.familyOf(title),
    jobFamily: family,
  });
  const fetchedAt = now();
  const lookupId = await insertSalaryLookup(db, {
    companyId: job.companyId,
    jobId,
    lookupKey,
    status: "done",
    result: verified,
    confidence: verified.confidence,
    provider: result.provider,
    model: result.model,
    promptVersion: SALARY_PROMPT_VERSION,
    errorCode: null,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + lookup.ttl_days * 86_400_000),
  });
  opts.logger?.info("salary looked up", { jobId, provider: result.provider, model: result.model, confidence: verified.confidence, sources: verified.sources.length, dropped: verified.dropped });
  return { status: "done", cached: false, lookupId, provider: result.provider, model: result.model, confidence: verified.confidence, sources: verified.sources.length, dropped: verified.dropped };
}
