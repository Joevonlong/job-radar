/** What the job page reads for its company background panel. Server only. */
import type { AiProviderId } from "@/lib/ai/types";
import type { AiConfig, ResearchConfig } from "@/lib/config";
import { companyResearchProviders, companyResearchUnrestricted, readInitialCompanyResearchRequest, type InitialCompanyResearchRequest } from "@/lib/control/company-research-request";
import type { Db } from "@/lib/db/client";
import { companyResearchTableReady, confirmedWebsiteDomain, countCompanyResearchRequests, getCompanyResearchForJob, getJobForCompanyResearch } from "@/lib/db/repos/company-research";

import { inferCompanyDomain, shownWebsite, type CompanyWebsite } from "./domain";
import type { CompanyResearchView } from "./fields";

export type CompanyResearchAvailability = "enabled" | "disabled" | "no_web_provider" | "config_error" | "not_ready";

export interface CompanyResearchContext {
  availability: CompanyResearchAvailability;
  providers: readonly AiProviderId[];
  /** A provider of the plan searches the web without a domain limit. */
  unrestricted: boolean;
  latest: CompanyResearchView | null;
  /** The website domain confirmed since the shown result was made differs from the one it used. */
  domainChanged: boolean;
  initialRequest: InitialCompanyResearchRequest | null;
  usedToday: number;
  maxPerDay: number;
  ttlDays: number;
  /** The company's website as far as it is known; an inferred one waits for the user's confirmation and is never sent anywhere. */
  companyId: number | null;
  website: CompanyWebsite | null;
}

/**
 * The panel's state, or null when there is nothing to show: the feature is off and no result is stored. A stored result stays
 * readable after the feature was turned off, without a button.
 */
export async function getCompanyResearchContext(db: Db, input: { jobId: number; research: ResearchConfig | null; ai: AiConfig | null; now: Date }): Promise<CompanyResearchContext | null> {
  const { research, ai, now } = input;
  const ready = await companyResearchTableReady(db);
  if (!ready && research?.enabled !== true) return null;
  const job = ready ? await getJobForCompanyResearch(db, input.jobId) : null;
  const latest = ready ? await getCompanyResearchForJob(db, input.jobId, now) : null;
  const providers = ai ? companyResearchProviders(ai) : [];
  const availability: CompanyResearchAvailability = !research || !ai ? "config_error" : !research.enabled ? "disabled" : !ready ? "not_ready" : providers.length === 0 ? "no_web_provider" : "enabled";
  if (availability === "disabled" && latest === null) return null;
  const website = job && research ? (availability === "enabled" && job.websiteDomain === null ? await inferCompanyDomain(db, job.companyId, research) : shownWebsite(job, research)) : null;
  return {
    availability,
    providers,
    unrestricted: ai ? companyResearchUnrestricted(ai) : false,
    latest,
    domainChanged: latest !== null && job !== null && latest.domainUsed !== confirmedWebsiteDomain(job),
    initialRequest: job ? await readInitialCompanyResearchRequest(db, { jobId: input.jobId, companyId: job.companyId, fetchedAt: latest?.fetchedAt ?? null }) : null,
    usedToday: availability === "enabled" ? await countCompanyResearchRequests(db, now) : 0,
    maxPerDay: research?.company.max_per_day ?? 0,
    ttlDays: research?.company.ttl_days ?? 0,
    companyId: job?.companyId ?? null,
    website,
  };
}
