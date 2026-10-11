/**
 * Web side of the translate button: the web app never calls an AI provider itself. It leaves a
 * `translate_job` request for the ai-worker (or the runner, with `execution: container`) and then asks for its
 * state. Server only; the Server Actions in `app/jobs/[id]/actions.ts` are the callers.
 */
import type { Db } from "@/lib/db/client";
import { findLatestJobControlRequest, findOpenTranslateRequest, getControlRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { getJobForTranslation, getTranslation, getTranslationProgress } from "@/lib/db/repos/translations";
import { TRANSLATION_FAILURE_CODES, type TranslationFailureCode } from "@/lib/translation/errors";
import { isTranslationStale } from "@/lib/translation/hash";
import { toJobTranslation, toPartialTranslation, type JobTranslation, type PartialTranslation } from "@/lib/translation/service";
import { languageSettings, translationTarget } from "@/lib/i18n/config";

/** The translation target as the web sees it now (no watcher in the web app: read the small file fresh). */
const currentTarget = (): string => translationTarget(languageSettings({ fresh: true }));
import { sameLanguage } from "@/lib/i18n/languages";

/** Error codes the translation tab has labels for: the real cause of a failure (`TranslationFailureCode`) plus the request-level ones. */
export type TranslateErrorCode = TranslationFailureCode | "not_found" | "no_description" | "same_language" | "aborted";
const ERROR_CODES: readonly TranslateErrorCode[] = [...TRANSLATION_FAILURE_CODES, "not_found", "no_description", "same_language", "aborted"];

/** The unfinished translation of a job (the pieces that are done), or null when there is none for the current description. */
export async function readPartialTranslation(db: Db, jobId: number): Promise<PartialTranslation | null> {
  const [job, progress] = await Promise.all([getJobForTranslation(db, jobId), getTranslationProgress(db, jobId, currentTarget())]);
  if (!job || !progress) return null;
  return toPartialTranslation(progress, job.description);
}

export type TranslateRequestOutcome =
  | { state: "cached"; translation: JobTranslation }
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "error"; error: "not_found" | "no_description" | "same_language" };

/** A current cached translation is returned as it is; otherwise a `translate_job` request is queued (an open one for the same job is reused). */
export async function requestTranslateJob(db: Db, input: { jobId: number; force: boolean }): Promise<TranslateRequestOutcome> {
  const job = await getJobForTranslation(db, input.jobId);
  if (!job) return { state: "error", error: "not_found" };
  if (job.description === null || job.description.trim() === "") return { state: "error", error: "no_description" };
  const target = currentTarget();
  if (sameLanguage(job.language, target)) return { state: "error", error: "same_language" };
  if (!input.force) {
    const cached = await getTranslation(db, input.jobId, target);
    if (cached && !isTranslationStale(cached.sourceHash, job.description)) return { state: "cached", translation: toJobTranslation(cached, job.description) };
  }
  const open = await findOpenTranslateRequest(db, input.jobId);
  if (open) return { state: "queued", requestId: open.id, existing: true };
  const created = await insertControlRequest(db, { kind: "translate_job", payload: { jobId: input.jobId, force: input.force } });
  return { state: "queued", requestId: created.id, existing: false };
}

export type TranslateRequestState =
  /** `partial`: how far the translation is (pieces done / total) and the text so far; null before the first piece. */
  | { state: "waiting"; stage: "pending" | "running"; partial: PartialTranslation | null }
  | { state: "done"; translation: JobTranslation }
  | { state: "failed"; error: TranslateErrorCode; detail: string | null; partial: PartialTranslation | null };

/** Where a queued translation stands. `jobId` must be the request's job: a request id alone never reveals another job's translation. */
export async function readTranslateRequest(db: Db, input: { requestId: number; jobId: number }): Promise<TranslateRequestState | null> {
  const request = await getControlRequest(db, input.requestId);
  const payload = typeof request?.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown }) : {};
  if (!request || request.kind !== "translate_job" || payload.jobId !== input.jobId) return null;
  if (request.status === "pending" || request.status === "running") return { state: "waiting", stage: request.status, partial: await readPartialTranslation(db, input.jobId) };
  if (request.status === "failed") {
    const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; detail?: unknown }) : {};
    return {
      state: "failed",
      error: ERROR_CODES.find((c) => c === result.error) ?? "failed",
      detail: typeof result.detail === "string" ? result.detail : null,
      partial: await readPartialTranslation(db, input.jobId),
    };
  }
  const job = await getJobForTranslation(db, input.jobId);
  const stored = await getTranslation(db, input.jobId, currentTarget());
  if (!job || !stored) return { state: "failed", error: "failed", detail: null, partial: null };
  return { state: "done", translation: toJobTranslation(stored, job.description) };
}

/** What the translate tab starts with after a page load: an open `translate_job` request means it waits again and polls. */
export async function readInitialTranslateRequest(db: Db, jobId: number): Promise<{ requestId: number; stage: "pending" | "running" } | null> {
  const request = await findLatestJobControlRequest(db, "translate_job", jobId);
  if (request?.status === "pending" || request?.status === "running") return { requestId: request.id, stage: request.status };
  return null;
}
