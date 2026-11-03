/**
 * Web side of the company background button: the web app never calls an AI provider itself. It leaves a `company_research`
 * request for the ai-worker and then asks for its state. Server only; `app/jobs/[id]/research-actions.ts` calls it.
 */
import { COMPANY_RESEARCH_PROMPT_VERSION } from "@/lib/ai/prompts/company-research";
import { resolveProviderOrder } from "@/lib/ai/router";
import { UNRESTRICTED_WEB_PROVIDERS, webAccessAllowed } from "@/lib/ai/web-tasks";
import type { AiProviderId } from "@/lib/ai/types";
import type { AiConfig, ResearchConfig } from "@/lib/config";
import { AI_PROVIDER_CONFIG_KEYS } from "@/lib/config/ai-options";
import type { Db } from "@/lib/db/client";
import { getControlRequest, isAutoOriginRequest } from "@/lib/db/repos/control-requests";
import { companyResearchCurrent, companyResearchTableReady, confirmedWebsiteDomain, findLatestCompanyResearch, findLatestCompanyResearchRequest, getJobForCompanyResearch, reserveCompanyResearchRequest } from "@/lib/db/repos/company-research";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { COMPANY_RESEARCH_ERROR_CODES, type CompanyResearchErrorCode } from "@/lib/research/company";
import { loadQueueView } from "./queue-view";
import { resumeAtOf, type ControlQueueView } from "./request-view-schema";

const log = createProcessLogger({ fields: { component: "control" } });

/** The providers the lookup may use: its plan in ai.yaml, switched on, able to search the web (`web-tasks.ts`). */
export function companyResearchProviders(ai: AiConfig): AiProviderId[] {
  return resolveProviderOrder(ai, "company_research").filter((id) => webAccessAllowed("company_research", id) && ai.providers[AI_PROVIDER_CONFIG_KEYS[id]].enabled);
}

/** Whether a provider of the plan searches the web without a domain limit (codex-cli, only when the user added it), for the warning on the panel. */
export function companyResearchUnrestricted(ai: AiConfig): boolean {
  return companyResearchProviders(ai).some((id) => UNRESTRICTED_WEB_PROVIDERS.has(id));
}

export type CompanyResearchRequestOutcome =
  /** A current result exists: nothing to do, the page refreshes. */
  | { state: "cached" }
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "error"; error: "disabled" | "config_error" | "not_found" | "no_web_provider" | "quota" | "not_ready" };

export async function requestCompanyResearch(
  db: Db,
  input: { jobId: number; force: boolean; origin?: "auto"; research: ResearchConfig | null; ai: AiConfig | null; now?: Date },
): Promise<CompanyResearchRequestOutcome> {
  if (!input.research || !input.ai) return { state: "error", error: "config_error" };
  if (!input.research.enabled) return { state: "error", error: "disabled" };
  if (companyResearchProviders(input.ai).length === 0) return { state: "error", error: "no_web_provider" };
  if (!(await companyResearchTableReady(db))) return { state: "error", error: "not_ready" };
  const job = await getJobForCompanyResearch(db, input.jobId);
  if (!job) return { state: "error", error: "not_found" };
  const now = input.now ?? new Date();
  if (!input.force) {
    const latest = await findLatestCompanyResearch(db, { companyId: job.companyId, promptVersion: COMPANY_RESEARCH_PROMPT_VERSION, now });
    if (companyResearchCurrent(latest, confirmedWebsiteDomain(job, input.research.company.non_company_hosts))) return { state: "cached" };
  }
  const reserved = await reserveCompanyResearchRequest(db, { companyId: job.companyId, jobId: input.jobId, force: input.force, ...(input.origin ? { origin: input.origin } : {}), maxPerDay: input.research.company.max_per_day, now });
  if (reserved.state === "quota") return { state: "error", error: "quota" };
  if (reserved.state === "queued") log.info(input.origin === "auto" ? "automatic request queued" : "manual request queued", { request: reserved.requestId, kind: "company_research", jobId: input.jobId });
  return { state: "queued", requestId: reserved.requestId, existing: reserved.state === "existing" };
}

export type CompanyResearchRequestState =
  /** `queue`: where the request stands (position, what the worker is doing, whether it is alive). */
  | { state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { state: "done" }
  | { state: "failed"; error: CompanyResearchErrorCode; detail: string | null; resumeAt: string | null }
  /** There is no such request, or it is neither this job's nor one of the same company. */
  | { state: "missing" };

/**
 * Where a queued lookup stands. The request must be this job's, or one for the same company (another posting of the company
 * joined it): a request id alone never reveals another company's request.
 */
export async function readCompanyResearchRequest(db: Db, input: { requestId: number; jobId: number; companyId?: number }): Promise<CompanyResearchRequestState> {
  const request = await getControlRequest(db, input.requestId);
  const payload = typeof request?.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown; companyId?: unknown }) : {};
  const mine = payload.jobId === input.jobId || (input.companyId !== undefined && payload.companyId === input.companyId);
  if (!request || request.kind !== "company_research" || !mine) return { state: "missing" };
  if (request.status === "pending" || request.status === "running") return { state: "waiting", stage: request.status, queue: await loadQueueView(db, request) };
  if (request.status === "failed") {
    const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; detail?: unknown; resumeAt?: unknown }) : {};
    return {
      state: "failed",
      error: COMPANY_RESEARCH_ERROR_CODES.find((code) => code === result.error) ?? "failed",
      detail: typeof result.detail === "string" ? result.detail : null,
      // with `quota_guard`: when Job Radar's AI usage cap is expected to let the AI work again
      resumeAt: resumeAtOf(result.resumeAt),
    };
  }
  return { state: "done" };
}

export type InitialCompanyResearchRequest =
  | { state: "waiting"; requestId: number; stage: "pending" | "running"; queue: ControlQueueView | null; /** Queued automatically: a press still moves it up. */ auto?: true }
  | { state: "failed"; error: CompanyResearchErrorCode; detail: string | null; resumeAt?: string | null };

/** What the panel starts with after a reload: an open request waits again; a failure newer than the shown result is shown. */
export async function readInitialCompanyResearchRequest(db: Db, input: { jobId: number; companyId: number; fetchedAt: Date | null }): Promise<InitialCompanyResearchRequest | null> {
  const request = await findLatestCompanyResearchRequest(db, input.companyId);
  if (!request) return null;
  const state = await readCompanyResearchRequest(db, { requestId: request.id, jobId: input.jobId, companyId: input.companyId });
  if (state.state === "waiting") return { state: "waiting", requestId: request.id, stage: state.stage, queue: state.queue, ...(isAutoOriginRequest(request.payload) ? { auto: true as const } : {}) };
  if (state.state !== "failed") return null;
  if (input.fetchedAt !== null && request.finishedAt !== null && request.finishedAt <= input.fetchedAt) return null;
  return state;
}
