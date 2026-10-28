"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { clearClosureOverride, getDb, jobExists, markSeen, reopenJob, restoreClosureOverride, setClosureOverride, type ClosureOverride } from "@/lib/db";
import { CLOSURE_NOTE_MAX } from "@/lib/jobs/closure";

/**
 * The user's own "this job is closed" / "it is still open" (single-user app bound to loopback, C5: no session; input validated,
 * C6). Each change answers with what was there before, so the toast's undo puts exactly that back. Closing a job also marks it seen
 * (a decision on it).
 */

const jobId = z.number().int().positive();

/** The judgement before a change, as it travels to the browser and back. */
export type PreviousClosure = { action: "closed" | "open"; note: string | null; createdAt: string } | null;
export type ClosureActionResult = { ok: true; previous: PreviousClosure } | { ok: false; error: "invalid" | "not_found" | "failed" };

const previousSchema = z.object({ action: z.enum(["closed", "open"]), note: z.string().max(CLOSURE_NOTE_MAX).nullable(), createdAt: z.iso.datetime({ offset: true }) }).nullable();

function serialise(previous: ClosureOverride | null): PreviousClosure {
  return previous ? { action: previous.action, note: previous.note, createdAt: previous.createdAt.toISOString() } : null;
}

function refreshViews(): void {
  revalidatePath("/", "layout");
}

/** Mark closed (or change the note of a job already marked closed; an empty note clears it). */
export async function closeJobAction(input: { jobId: number; note?: string | null }): Promise<ClosureActionResult> {
  const parsed = z.object({ jobId, note: z.string().max(CLOSURE_NOTE_MAX).nullish() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const note = parsed.data.note?.trim() ? parsed.data.note.trim() : null;
    const previous = await setClosureOverride(db, parsed.data.jobId, "closed", note);
    await markSeen(db, parsed.data.jobId, "action");
    refreshViews();
    return { ok: true, previous: serialise(previous) };
  } catch (error) {
    logActionFailure("closeJobAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Reopen (see `reopenJob`). */
export async function reopenJobAction(input: { jobId: number }): Promise<ClosureActionResult> {
  const parsed = z.object({ jobId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const previous = await reopenJob(db, parsed.data.jobId);
    await markSeen(db, parsed.data.jobId, "action");
    refreshViews();
    return { ok: true, previous: serialise(previous) };
  } catch (error) {
    logActionFailure("reopenJobAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Undo the last change: put back the judgement that was there before it (none = the automatic status). */
export async function undoClosureAction(input: { jobId: number; previous: PreviousClosure }): Promise<{ ok: boolean }> {
  const parsed = z.object({ jobId, previous: previousSchema }).safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const db = getDb();
    const previous = parsed.data.previous;
    if (previous === null) await clearClosureOverride(db, parsed.data.jobId);
    else await restoreClosureOverride(db, parsed.data.jobId, { action: previous.action, note: previous.note, createdAt: new Date(previous.createdAt) });
    refreshViews();
    return { ok: true };
  } catch (error) {
    logActionFailure("undoClosureAction", error);
    return { ok: false };
  }
}
