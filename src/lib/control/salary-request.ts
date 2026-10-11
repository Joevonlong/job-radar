/**
 * Web side of the salary lookup button: the web app never calls an AI provider itself. It leaves a
 * `salary_lookup` request for the ai-worker and then asks for its state. Server only; `app/jobs/[id]/salary-actions.ts`
 * calls it.
 */
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { resolveProviderOrder } from "@/lib/ai/router";
import { UNRESTRICTED_WEB_PROVIDERS, webAccessAllowed } from "@/lib/ai/web-tasks";
import type { AiProviderId } from "@/lib/ai/types";
import { createLogger } from "@/lib/channels/logger";
import type { AiConfig, SalaryConfig } from "@/lib/config";
import { AI_PROVIDER_CONFIG_KEYS } from "@/lib/config/ai-options";
import type { Db } from "@/lib/db/client";
import { getControlRequest } from "@/lib/db/repos/control-requests";
import { findLatestSalaryLookup, findLatestSalaryLookupRequest, getJobForSalaryLookup, reserveSalaryLookupRequest, salaryTablesReady } from "@/lib/db/repos";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey, SALARY_ERROR_CODES, type SalaryErrorCode } from "@/lib/salary/lookup";
import { resumeAtOf } from "./request-view-schema";

const log = createLogger({ fields: { component: "control" } });

/** The providers the lookup may use: its plan in ai.yaml, switched on, able to search the web (`web-tasks.ts`). */
export function salaryLookupProviders(ai: AiConfig): AiProviderId[] {
  return resolveProviderOrder(ai, "salary_lookup").filter((id) => webAccessAllowed("salary_lookup", id) && ai.providers[AI_PROVIDER_CONFIG_KEYS[id]].enabled);
}

/** Whether a provider of the plan searches the web without a domain limit (codex-cli), for the warning in the settings and on the card. */
export function salaryLookupUnrestricted(ai: AiConfig): boolean {
  return salaryLookupProviders(ai).some((id) => UNRESTRICTED_WEB_PROVIDERS.has(id));
}

export type SalaryRequestOutcome =
  /** A current lookup exists: nothing to do, the page refreshes. */
  | { state: "cached" }
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "error"; error: "disabled" | "config_error" | "not_found" | "no_web_provider" | "quota" | "not_ready" };

export async function requestSalaryLookup(
  db: Db,
  input: { jobId: number; force: boolean; salary: SalaryConfig | null; ai: AiConfig | null; now?: Date },
): Promise<SalaryRequestOutcome> {
  if (!input.salary || !input.ai) return { state: "error", error: "config_error" };
  if (!input.salary.lookup.enabled) return { state: "error", error: "disabled" };
  if (salaryLookupProviders(input.ai).length === 0) return { state: "error", error: "no_web_provider" };
  if (!(await salaryTablesReady(db))) return { state: "error", error: "not_ready" };
  const job = await getJobForSalaryLookup(db, input.jobId);
  if (!job) return { state: "error", error: "not_found" };
  const now = input.now ?? new Date();
  const lookupKey = salaryLookupKey(job, compileFamilies(input.salary.role_families).familyOf(job.title));
  if (!input.force) {
    const cached = await findLatestSalaryLookup(db, { lookupKey, promptVersion: SALARY_PROMPT_VERSION });
    if (cached && cached.expiresAt > now) return { state: "cached" };
  }
  const reserved = await reserveSalaryLookupRequest(db, { lookupKey, jobId: input.jobId, force: input.force, maxPerDay: input.salary.lookup.max_per_day, now });
  if (reserved.state === "quota") return { state: "error", error: "quota" };
  if (reserved.state === "queued") log.info("manual request queued", { request: reserved.requestId, kind: "salary_lookup", jobId: input.jobId });
  return { state: "queued", requestId: reserved.requestId, existing: reserved.state === "existing" };
}

export type SalaryRequestState =
  | { state: "waiting"; stage: "pending" | "running" }
  | { state: "done" }
  | { state: "failed"; error: SalaryErrorCode; detail: string | null; resumeAt: string | null };

/**
 * Where a queued lookup stands. The request must be this job's, or one for the same lookup key (another posting of the same
 * role joined it): a request id alone never reveals another job's request.
 */
export async function readSalaryLookupRequest(db: Db, input: { requestId: number; jobId: number; lookupKey?: string }): Promise<SalaryRequestState | null> {
  const request = await getControlRequest(db, input.requestId);
  const payload = typeof request?.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown; lookupKey?: unknown }) : {};
  const mine = payload.jobId === input.jobId || (input.lookupKey !== undefined && payload.lookupKey === input.lookupKey);
  if (!request || request.kind !== "salary_lookup" || !mine) return null;
  if (request.status === "pending" || request.status === "running") return { state: "waiting", stage: request.status };
  if (request.status === "failed") {
    const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; detail?: unknown; resumeAt?: unknown }) : {};
    return {
      state: "failed",
      error: SALARY_ERROR_CODES.find((c) => c === result.error) ?? "failed",
      detail: typeof result.detail === "string" ? result.detail : null,
      // with `quota_guard`: when Job Radar's AI usage cap is expected to let the AI work again
      resumeAt: resumeAtOf(result.resumeAt),
    };
  }
  return { state: "done" };
}

export type InitialSalaryRequest =
  | { state: "waiting"; requestId: number; stage: "pending" | "running" }
  | { state: "failed"; error: SalaryErrorCode; detail: string | null; resumeAt?: string | null };

/** What the lookup card starts with after a reload: an open request waits again; a failure newer than the shown result is shown. */
export async function readInitialSalaryRequest(db: Db, input: { jobId: number; lookupKey: string; fetchedAt: Date | null }): Promise<InitialSalaryRequest | null> {
  const request = await findLatestSalaryLookupRequest(db, input);
  if (!request) return null;
  const state = await readSalaryLookupRequest(db, { requestId: request.id, jobId: input.jobId, lookupKey: input.lookupKey });
  if (state?.state === "waiting") return { state: "waiting", requestId: request.id, stage: state.stage };
  if (state?.state !== "failed") return null;
  if (input.fetchedAt !== null && request.finishedAt !== null && request.finishedAt <= input.fetchedAt) return null;
  return state;
}
