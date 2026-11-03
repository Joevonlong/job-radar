/** The research bar on the job page: where the company lookup, the JD breakdown and the salary lookup of one job stand. */
import { COMPANY_RESEARCH_PROMPT_VERSION } from "@/lib/ai/prompts/company-research";
import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import type { BreakdownSettingsState } from "@/lib/breakdown/settings";
import type { AiConfig, ResearchConfig } from "@/lib/config";
import { RESEARCH_ITEMS, type ResearchItem } from "@/lib/config/schemas/research";
import { readInitialBreakdownRequest } from "@/lib/control/breakdown-request";
import { companyResearchProviders, readInitialCompanyResearchRequest } from "@/lib/control/company-research-request";
import { readInitialSalaryRequest, salaryLookupProviders } from "@/lib/control/salary-request";
import type { Db } from "@/lib/db/client";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { companyResearchCurrent, confirmedWebsiteDomain, findLatestCompanyResearch, getJobForCompanyResearch } from "@/lib/db/repos/company-research";
import { findLatestSalaryLookup, getJobForSalaryLookup } from "@/lib/db/repos/salary-lookups";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey } from "@/lib/salary/lookup-key";
import type { SalarySettingsState } from "@/lib/salary/settings";
import { descriptionHash } from "@/lib/translation/hash";

import type { ResearchBarStatus, ResearchItemStatus } from "./bar-view";

export type { ResearchBarStatus, ResearchItemStatus } from "./bar-view";

const ageDays = (at: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));

type Initial = { state: "waiting"; stage: "pending" | "running"; auto?: true } | { state: "failed"; error: string; resumeAt?: string | null } | null;

/**
 * An open request, then a part that is off (a result would come with a refresh that cannot run), then a failed request, a result,
 * and whatever the settings say. `research_disabled`: stopped earlier, nothing to report. With research itself off nothing can be
 * pressed, so `offWins` is false and stored results stay listed.
 */
function fromParts(initial: Initial, result: { at: Date; expired: boolean } | null, now: Date, otherwise: ResearchItemStatus, offWins: boolean): ResearchItemStatus {
  if (initial?.state === "waiting") return { state: "running", stage: initial.stage, auto: initial.auto === true };
  if (offWins && otherwise.state === "off") return otherwise;
  if (initial?.state === "failed" && initial.error === "quota_guard") return { state: "deferred", resumeAt: initial.resumeAt ?? null };
  if (initial?.state === "failed" && initial.error !== "research_disabled") return { state: "failed", error: initial.error };
  if (result) return { state: "done", ageDays: ageDays(result.at, now), expired: result.expired };
  return otherwise;
}

async function companyStatus(db: Db, jobId: number, research: ResearchConfig, ai: AiConfig | null, now: Date): Promise<ResearchItemStatus> {
  const job = await getJobForCompanyResearch(db, jobId);
  if (!job) return { state: "unavailable" };
  const latest = await findLatestCompanyResearch(db, { companyId: job.companyId, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, now });
  const initial = await readInitialCompanyResearchRequest(db, { jobId, companyId: job.companyId, fetchedAt: latest?.fetchedAt ?? null });
  const usable = ai !== null && companyResearchProviders(ai).length > 0;
  const result = latest ? { at: latest.fetchedAt, expired: !companyResearchCurrent(latest, confirmedWebsiteDomain(job)) } : null;
  return fromParts(initial, result, now, usable && research.enabled ? { state: "missing" } : { state: "off", settingsTab: "ai" }, research.enabled);
}

async function breakdownStatus(db: Db, jobId: number, settings: BreakdownSettingsState, now: Date, offWins: boolean): Promise<ResearchItemStatus> {
  const row = await getJobBreakdown(db, jobId);
  const initial = await readInitialBreakdownRequest(db, jobId, row?.analyzedAt ?? null);
  const job = await getJobForBreakdown(db, jobId);
  const hasText = job !== null && job.description !== null && job.description.trim() !== "";
  const result = row && row.analyzedAt ? { at: row.analyzedAt, expired: !hasText || row.sourceHash !== descriptionHash(job.description) || row.promptVersion !== BREAKDOWN_PROMPT_VERSION } : null;
  const on = settings.state === "ok" && settings.config.enabled;
  return fromParts(initial, result, now, !on ? { state: "off", settingsTab: "breakdown" } : hasText ? { state: "missing" } : { state: "unavailable" }, offWins);
}

async function salaryStatus(db: Db, jobId: number, settings: SalarySettingsState, ai: AiConfig | null, now: Date, offWins: boolean): Promise<ResearchItemStatus> {
  const on = settings.state === "ok" && settings.config.lookup.enabled;
  if (settings.state !== "ok") return { state: "off", settingsTab: "salary" };
  const job = await getJobForSalaryLookup(db, jobId);
  if (!job) return { state: "unavailable" };
  const lookupKey = salaryLookupKey(job, compileFamilies(settings.config.role_families).familyOf(job.title));
  const cached = await findLatestSalaryLookup(db, { lookupKey, promptVersion: SALARY_PROMPT_VERSION });
  const initial = await readInitialSalaryRequest(db, { jobId, lookupKey, fetchedAt: cached?.fetchedAt ?? null });
  const result = cached ? { at: cached.fetchedAt, expired: cached.expiresAt <= now } : null;
  const otherwise: ResearchItemStatus = !on ? { state: "off", settingsTab: "salary" } : ai === null || salaryLookupProviders(ai).length === 0 ? { state: "off", settingsTab: "ai" } : { state: "missing" };
  return fromParts(initial, result, now, otherwise, offWins);
}

/**
 * Null when there is nothing to show: research is off and no part has a result, or research.yaml cannot be read. So installations
 * that left research off see no bar.
 */
export async function getResearchBarStatus(db: Db, input: { jobId: number; research: ResearchConfig | null; ai: AiConfig | null; salary: SalarySettingsState; breakdown: BreakdownSettingsState; now: Date }): Promise<ResearchBarStatus | null> {
  if (!input.research) return null;
  const all: Record<ResearchItem, ResearchItemStatus> = {
    company: await companyStatus(db, input.jobId, input.research, input.ai, input.now),
    breakdown: await breakdownStatus(db, input.jobId, input.breakdown, input.now, input.research.enabled),
    salary: await salaryStatus(db, input.jobId, input.salary, input.ai, input.now, input.research.enabled),
  };
  if (input.research.enabled) return { canRequest: true, items: all };
  const items: ResearchBarStatus["items"] = {};
  for (const item of RESEARCH_ITEMS) if (all[item].state === "done") items[item] = all[item];
  return Object.keys(items).length > 0 ? { canRequest: false, items } : null;
}

export { RESEARCH_ITEMS, type ResearchItem };
