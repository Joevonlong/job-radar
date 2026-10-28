"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requestTranslateJob, readTranslateRequest, type TranslateErrorCode } from "@/lib/control/translate-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { requestScoreJobs, type ControlActionState } from "@/lib/control/service";
import { MARK_APPLIED_FROM } from "@/lib/dashboard/apply";
import { NOTES_MAX_CHARS } from "@/lib/dashboard/limits";
import { getDb, jobExists, setApplicationNotes, setApplicationStatus, APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/db";
import type { JobTranslation, PartialTranslation } from "@/lib/translation/service";

/**
 * Server Actions for the application state of a job (status, notes). The web app is single-user and
 * bound to loopback (C5), so there is no session to check; input is still validated (C6).
 */

const jobIdSchema = z.number().int().positive();
const statusInputSchema = z.object({
  jobId: jobIdSchema,
  status: z.enum(APPLICATION_STATUSES as readonly [ApplicationStatus, ...ApplicationStatus[]]),
});
const notesInputSchema = z.object({
  jobId: jobIdSchema,
  notes: z.string().max(NOTES_MAX_CHARS),
});

export type StatusActionResult =
  | { ok: true; previous: ApplicationStatus | null; status: ApplicationStatus; changed: boolean }
  | { ok: false; error: "invalid" | "not_found" | "failed" };

export type NotesActionResult = { ok: true } | { ok: false; error: "invalid" | "not_found" | "failed" };

/** Everything that shows a status or notes (lists, detail, the pipeline later) re-reads after a change. */
function refreshViews(): void {
  revalidatePath("/", "layout");
}

/** Set the application status of a job (creates the application when there is none) and record an event. */
export async function setApplicationStatusAction(input: { jobId: number; status: string }): Promise<StatusActionResult> {
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const change = await setApplicationStatus(db, parsed.data.jobId, parsed.data.status);
    refreshViews();
    return { ok: true, previous: change.previous, status: change.status, changed: change.changed };
  } catch {
    return { ok: false, error: "failed" };
  }
}

const markAppliedInputSchema = z.object({ jobId: jobIdSchema });

export type MarkAppliedResult =
  | { ok: true; previous: ApplicationStatus | null; status: "applied"; changed: boolean }
  | { ok: false; error: "invalid" | "not_found" | "not_allowed" | "failed" };

/**
 * "Mark applied": the explicit, separate act after the user really applied. Opening the posting never calls this.
 * Only from `new / interested / preparing / archived`; an application that is further along is left alone (`not_allowed`),
 * and an already applied one is a no-op (`changed: false`, no event).
 */
export async function markAppliedAction(input: { jobId: number }): Promise<MarkAppliedResult> {
  const parsed = markAppliedInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const change = await setApplicationStatus(db, parsed.data.jobId, "applied", null, { allowFrom: MARK_APPLIED_FROM });
    if (change.rejected) return { ok: false, error: "not_allowed" };
    refreshViews();
    return { ok: true, previous: change.previous, status: "applied", changed: change.changed };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** Save the notes of a job's application. */
export async function saveApplicationNotesAction(input: { jobId: number; notes: string }): Promise<NotesActionResult> {
  const parsed = notesInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    await setApplicationNotes(db, parsed.data.jobId, parsed.data.notes);
    refreshViews();
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

const translateInputSchema = z.object({ jobId: jobIdSchema, force: z.boolean().optional() });
const translateStatusInputSchema = z.object({ jobId: jobIdSchema, requestId: z.number().int().positive() });

/** What the translation tab shows (dates as ISO strings: this crosses to a client component). */
export interface TranslationPayload {
  content: string;
  provider: string | null;
  createdAt: string;
  stale: boolean;
}

export type TranslateErrorKey = "invalid" | TranslateErrorCode;

/** A translation that is not finished: the text of the pieces that are done, and how far it got. */
export interface PartialPayload {
  content: string;
  done: number;
  total: number;
}

/** `queued`: the AI work was left for the ai-worker on the host; the tab asks `translateStatusAction` until it is done. */
export type TranslateActionResult =
  | { ok: true; queued: false; cached: boolean; translation: TranslationPayload }
  | { ok: true; queued: true; requestId: number }
  | { ok: false; error: TranslateErrorKey };

export type TranslateStatusResult =
  /** The state could not be read this time; the browser retries. */
  | null
  /** `queue`: where the request stands (position, what the worker is doing, whether it is alive). */
  | { ok: true; state: "waiting"; stage: "pending" | "running"; partial: PartialPayload | null; queue: ControlQueueView | null }
  | { ok: true; state: "done"; translation: TranslationPayload }
  /** `detail`: which provider failed how (no JD text); `partial`: what is saved, a retry continues from there. */
  | { ok: false; error: TranslateErrorKey; detail?: string | null; partial?: PartialPayload | null; resumeAt?: string | null };

const toPartial = (partial: PartialTranslation | null): PartialPayload | null => (partial ? { content: partial.content, done: partial.done, total: partial.total } : null);

const toPayload = (translation: JobTranslation): TranslationPayload => ({
  content: translation.content,
  provider: translation.provider,
  createdAt: translation.createdAt.toISOString(),
  stale: translation.stale,
});

/**
 * Translate a job's JD into Chinese (the button on the translation tab). A current cached translation is
 * returned at once; otherwise the request is queued for the ai-worker (this web app calls no AI
 * provider) and the tab polls `translateStatusAction`. `force` (used for an outdated translation) translates again.
 */
export async function translateJobAction(input: { jobId: number; force?: boolean }): Promise<TranslateActionResult> {
  const parsed = translateInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const outcome = await requestTranslateJob(getDb(), { jobId: parsed.data.jobId, force: parsed.data.force ?? false });
    if (outcome.state === "error") return { ok: false, error: outcome.error };
    if (outcome.state === "cached") return { ok: true, queued: false, cached: true, translation: toPayload(outcome.translation) };
    return { ok: true, queued: true, requestId: outcome.requestId };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** State of a queued translation: still waiting, done (the translation is returned and the page refreshed), or the reason it failed. */
export async function translateStatusAction(input: { jobId: number; requestId: number }): Promise<TranslateStatusResult> {
  const parsed = translateStatusInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const state = await readTranslateRequest(getDb(), parsed.data);
    if (state.state === "missing") return { ok: false, error: "not_found" };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, partial: toPartial(state.partial), queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, detail: state.detail, partial: toPartial(state.partial), resumeAt: state.resumeAt };
    revalidatePath(`/jobs/${parsed.data.jobId}`);
    return { ok: true, state: "done", translation: toPayload(state.translation) };
  } catch {
    return null;
  }
}

/**
 * "Score now" on a job that waits for its AI score: leaves a `score_jobs` request for the process that scores (the
 * ai-worker, or the runner with `execution: container`; the web app never calls the AI for scoring itself) and returns
 * the request the button polls at `/api/control/requests/<id>`.
 */
export async function scoreJobNowAction(input: { jobId: number }): Promise<ControlActionState> {
  const parsed = z.object({ jobId: jobIdSchema }).safeParse(input);
  if (!parsed.success) return { status: "error", error: "invalidPayload", nonce: Date.now() };
  return requestScoreJobs({ jobIds: [parsed.data.jobId] });
}
