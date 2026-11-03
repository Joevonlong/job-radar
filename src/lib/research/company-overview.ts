/** What the company list reads for a page of companies. Only reads: opening the list never starts a lookup. Server only. */
import { COMPANY_RESEARCH_PROMPT_VERSION } from "@/lib/ai/prompts/company-research";
import type { AiProviderId } from "@/lib/ai/types";
import type { AiConfig, ResearchConfig } from "@/lib/config";
import { companyResearchProviders } from "@/lib/control/company-research-request";
import type { Db } from "@/lib/db/client";
import { companyResearchTableReady, listCompanyResearchOverview } from "@/lib/db/repos/company-research";

import { shownWebsite, type CompanyWebsite } from "./domain";
import type { CompanyResearchView } from "./fields";

export interface CompanyResearchItem {
  latest: CompanyResearchView | null;
  website: CompanyWebsite | null;
  jobId: number | null;
}

export interface CompanyResearchOverview {
  canRefresh: boolean;
  canEditDomain: boolean;
  providers: readonly AiProviderId[];
  items: Record<number, CompanyResearchItem>;
}

/** Null when there is nothing to show: research is off and none of these companies has a stored result. */
export async function getCompanyResearchOverview(db: Db, input: { companyIds: readonly number[]; research: ResearchConfig | null; ai: AiConfig | null; now: Date }): Promise<CompanyResearchOverview | null> {
  const { research, ai, now } = input;
  if (!research || !(await companyResearchTableReady(db))) return null;
  const rows = await listCompanyResearchOverview(db, { companyIds: input.companyIds, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, now });
  const items: CompanyResearchOverview["items"] = {};
  for (const row of rows) {
    if (!research.enabled && row.latest === null) continue;
    items[row.companyId] = { latest: row.latest, website: research.enabled ? shownWebsite(row, research) : null, jobId: row.jobId };
  }
  if (!research.enabled && Object.keys(items).length === 0) return null;
  const providers = ai ? companyResearchProviders(ai) : [];
  return { canRefresh: research.enabled && providers.length > 0, canEditDomain: research.enabled, providers, items };
}
