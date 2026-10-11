"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { nextActionDateToTimestamp } from "@/lib/dashboard/board";
import { INTERVIEW_ROUNDS_MAX, NEXT_ACTION_MAX_CHARS } from "@/lib/dashboard/limits";
import { APPLICATION_STATUSES, getDb, jobExists, revertApplicationStatus, setApplicationNextAction, setInterviewRounds, type ApplicationStatus } from "@/lib/db";
import { isCalendarDate } from "@/lib/jobs/search-params";

/**
 * Server Actions of the pipeline board that the job detail does not have (next step, interview
 * rounds). Status changes and notes reuse `setApplicationStatusAction` / `saveApplicationNotesAction`
 * of the job detail, so every status change goes through one place and writes one event. The web app
 * is single-user and bound to loopback (C5); input is still validated (C6).
 */

export type PipelineActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: "invalid" | "not_found" | "failed" };

const jobIdSchema = z.number().int().positive();
const nextActionSchema = z.object({
  jobId: jobIdSchema,
  nextAction: z.string().max(NEXT_ACTION_MAX_CHARS),
  /** `YYYY-MM-DD`, or empty / null for no date. */
  nextActionDate: z
    .string()
    .refine((value) => value === "" || isCalendarDate(value))
    .nullable(),
});
const statusSchema = z.enum(APPLICATION_STATUSES as readonly [ApplicationStatus, ...ApplicationStatus[]]);
const undoSchema = z.object({ jobId: jobIdSchema, movedTo: statusSchema, restoreTo: statusSchema });
const roundsSchema = z.object({ jobId: jobIdSchema, rounds: z.number().int().min(0).max(INTERVIEW_ROUNDS_MAX) });

/** Save the next step (text and date) of a job's application; blank values clear them. */
export async function saveNextActionAction(input: { jobId: number; nextAction: string; nextActionDate: string | null }): Promise<PipelineActionResult> {
  const parsed = nextActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const text = parsed.data.nextAction.trim();
    const date = parsed.data.nextActionDate;
    const found = await setApplicationNextAction(getDb(), parsed.data.jobId, {
      nextAction: text === "" ? null : text,
      nextActionAt: date ? nextActionDateToTimestamp(date) : null,
    });
    if (!found) return { ok: false, error: "not_found" };
    revalidatePath("/pipeline");
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** Set the interview rounds of a job's application. */
export async function setInterviewRoundsAction(input: { jobId: number; rounds: number }): Promise<PipelineActionResult<{ rounds: number }>> {
  const parsed = roundsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const rounds = await setInterviewRounds(getDb(), parsed.data.jobId, parsed.data.rounds, INTERVIEW_ROUNDS_MAX);
    if (rounds === null) return { ok: false, error: "not_found" };
    revalidatePath("/pipeline");
    return { ok: true, rounds };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * The Undo of a status-change toast: takes the move back (event and clock) instead of writing a second event; see
 * `revertApplicationStatus`. Falls back to a normal change when the history has moved on.
 */
export async function undoApplicationStatusAction(input: { jobId: number; movedTo: string; restoreTo: string }): Promise<PipelineActionResult<{ status: ApplicationStatus | null }>> {
  const parsed = undoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const result = await revertApplicationStatus(db, parsed.data.jobId, { movedTo: parsed.data.movedTo, restoreTo: parsed.data.restoreTo });
    revalidatePath("/", "layout");
    return { ok: true, status: result.status };
  } catch {
    return { ok: false, error: "failed" };
  }
}
