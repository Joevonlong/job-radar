/**
 * Web side of the breakdown button: the web app never calls an AI provider itself. It leaves a `breakdown_job`
 * request for the ai-worker and then asks for its state. Server only; `app/jobs/[id]/breakdown-actions.ts` calls it.
 */
import type { BreakdownSettingsState } from "@/lib/breakdown/settings";
import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import type { Db } from "@/lib/db/client";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { findLatestJobControlRequest, findOpenJobControlRequest, getControlRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";
import { descriptionHash } from "@/lib/translation/hash";
import { resumeAtOf } from "./request-view-schema";

const log = createProcessLogger({ fields: { component: "control" } });

/** Error codes the breakdown card has labels for: the AI failure classes of the translation plus the request-level ones. */
export const BREAKDOWN_ERROR_CODES = [
  ...TRANSLATION_FAILURE_CODES,
  "disabled",
  "config_error",
  "not_found",
  "no_description",
  "no_verified_quotes",
  "aborted",
  "invalid_payload",
  "handler_error",
  "no_handler",
] as const;
export type BreakdownErrorCode = (typeof BREAKDOWN_ERROR_CODES)[number];

export type BreakdownRequestOutcome =
  /** A current breakdown exists: nothing to do, the page refreshes. */
  | { state: "cached" }
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "error"; error: "disabled" | "config_error" | "not_found" | "no_description" };

export async function requestBreakdownJob(db: Db, input: { jobId: number; force: boolean; settings: BreakdownSettingsState }): Promise<BreakdownRequestOutcome> {
  if (input.settings.state === "error") return { state: "error", error: "config_error" };
  if (!input.settings.config.enabled) return { state: "error", error: "disabled" };
  const job = await getJobForBreakdown(db, input.jobId);
  if (!job) return { state: "error", error: "not_found" };
  if (job.description === null || job.description.trim() === "") return { state: "error", error: "no_description" };
  if (!input.force) {
    const existing = await getJobBreakdown(db, input.jobId);
    if (existing && existing.sourceHash === descriptionHash(job.description) && existing.promptVersion === BREAKDOWN_PROMPT_VERSION) return { state: "cached" };
  }
  const open = await findOpenJobControlRequest(db, "breakdown_job", input.jobId);
  if (open) return { state: "queued", requestId: open.id, existing: true };
  const created = await insertControlRequest(db, { kind: "breakdown_job", payload: { jobId: input.jobId, force: input.force } });
  log.info("manual request queued", { request: created.id, kind: created.kind, jobId: input.jobId });
  return { state: "queued", requestId: created.id, existing: false };
}

export type BreakdownRequestState =
  | { state: "waiting"; stage: "pending" | "running" }
  | { state: "done" }
  /** `resumeAt`: with `quota_guard`, when Job Radar's AI usage cap is expected to let the AI work again (ISO; null = not known). */
  | { state: "failed"; error: BreakdownErrorCode; detail: string | null; resumeAt: string | null };

/** Where a queued breakdown stands. `jobId` must be the request's job: a request id alone never reveals another job's request. Null: no such request. */
export async function readBreakdownRequest(db: Db, input: { requestId: number; jobId: number }): Promise<BreakdownRequestState | null> {
  const request = await getControlRequest(db, input.requestId);
  const payload = typeof request?.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown }) : {};
  if (!request || request.kind !== "breakdown_job" || payload.jobId !== input.jobId) return null;
  if (request.status === "pending" || request.status === "running") return { state: "waiting", stage: request.status };
  if (request.status === "failed") {
    const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; detail?: unknown; resumeAt?: unknown }) : {};
    return {
      state: "failed",
      error: BREAKDOWN_ERROR_CODES.find((c) => c === result.error) ?? "failed",
      detail: typeof result.detail === "string" ? result.detail : null,
      resumeAt: resumeAtOf(result.resumeAt),
    };
  }
  return { state: "done" };
}

/** What the card starts with after a page load, from the job's newest `breakdown_job` request (null: nothing to resume). */
export type InitialBreakdownRequest =
  | { state: "waiting"; requestId: number; stage: "pending" | "running" }
  | { state: "failed"; error: BreakdownErrorCode; detail: string | null; resumeAt?: string | null };

/**
 * The server's memory of the card: an open request means the card waits again (and polls); a request that ended
 * in an error after the stored result was made shows the failure with its retry. `analyzedAt`: when the shown result was made.
 */
export async function readInitialBreakdownRequest(db: Db, jobId: number, analyzedAt: Date | null): Promise<InitialBreakdownRequest | null> {
  const request = await findLatestJobControlRequest(db, "breakdown_job", jobId);
  if (!request) return null;
  const state = await readBreakdownRequest(db, { requestId: request.id, jobId });
  if (state?.state === "waiting") return { state: "waiting", requestId: request.id, stage: state.stage };
  if (state?.state !== "failed") return null;
  if (analyzedAt !== null && request.finishedAt !== null && request.finishedAt <= analyzedAt) return null;
  return state;
}
