"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { getFormatter, getTranslations } from "next-intl/server";
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import type { RepliesConfig } from "@/lib/config/schemas/replies";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { confirmReply, dismissReply, reassignReply, recategorizeReply, undoReply, type ReplyDecision } from "@/lib/db/repos/replies";
import { PICKABLE_CATEGORIES } from "@/lib/replies/types";

import { nextActionDateToTimestamp } from "@/lib/dashboard/board";
import { INTERVIEW_ROUNDS_MAX, NEXT_ACTION_MAX_CHARS } from "@/lib/dashboard/limits";
import { APPLICATION_STATUSES, getDb, jobExists, revertApplicationStatus, setApplicationNextAction, setInterviewRounds, type ApplicationStatus } from "@/lib/db";
import { isCalendarDate } from "@/lib/jobs/search-params";

/**
 * Server Actions of the pipeline board that the job detail does not have (next step, interview
 * rounds). Status changes and notes reuse `setApplicationStatusAction` / `saveApplicationNotesAction`
 * of the job detail, so every status change goes through one place and writes one event. The web app
 * is single-user and bound to loopback; input is still validated.
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
  } catch (error) {
    logActionFailure("saveNextActionAction", error);
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
  } catch (error) {
    logActionFailure("setInterviewRoundsAction", error);
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
  } catch (error) {
    logActionFailure("undoApplicationStatusAction", error);
    return { ok: false, error: "failed" };
  }
}

const replyIdSchema = z.number().int().positive();
const replyCategorySchema = z.enum(PICKABLE_CATEGORIES);

export type ReplyActionResult = { ok: true; outcome: "done" | "superseded" | "stale" } | { ok: false; error: "invalid" | "failed" };

/** Run a decision on a reply. The words on the application come from the messages, in the viewer's language. */
async function decideReply(name: string, parsed: boolean, run: (config: RepliesConfig, now: Date) => Promise<ReplyDecision>): Promise<ReplyActionResult> {
  if (!parsed) return { ok: false, error: "invalid" };
  try {
    const decision = await run(loadConfig("replies"), new Date());
    revalidatePath("/pipeline");
    return { ok: true, outcome: decision.outcome };
  } catch (error) {
    logActionFailure(name, error);
    return { ok: false, error: "failed" };
  }
}

/** Carry out what a reply suggests (the only way a reply changes an application). */
export async function confirmReplyAction(input: { id: number }): Promise<ReplyActionResult> {
  const id = replyIdSchema.safeParse(input.id);
  return decideReply("confirmReplyAction", id.success, async (config, now) => {
    const [t, format] = await Promise.all([getTranslations("replies"), getFormatter()]);
    const timeZone = getDisplayTimeZone();
    return confirmReply(getDb(), input.id, {
      transitions: config.transitions,
      now,
      describe: {
        note: (category, receivedAt) => t("eventNote", { category: t(`category.${category}`), date: format.dateTime(receivedAt, { dateStyle: "medium", timeZone }) }),
        nextAction: (action) => t(`nextAction.${action}`),
      },
    });
  });
}

export async function undoReplyAction(input: { id: number }): Promise<ReplyActionResult> {
  const id = replyIdSchema.safeParse(input.id);
  return decideReply("undoReplyAction", id.success, (config, now) => undoReply(getDb(), input.id, { transitions: config.transitions, now }));
}

export async function dismissReplyAction(input: { id: number }): Promise<ReplyActionResult> {
  const id = replyIdSchema.safeParse(input.id);
  return decideReply("dismissReplyAction", id.success, (_config, now) => dismissReply(getDb(), input.id, now));
}

export async function reassignReplyAction(input: { id: number; jobId: number }): Promise<ReplyActionResult> {
  const parsed = z.object({ id: replyIdSchema, jobId: jobIdSchema }).safeParse(input);
  return decideReply("reassignReplyAction", parsed.success, (config, now) => reassignReply(getDb(), input.id, { jobId: input.jobId, transitions: config.transitions, now }));
}

export async function recategorizeReplyAction(input: { id: number; category: string }): Promise<ReplyActionResult> {
  const parsed = z.object({ id: replyIdSchema, category: replyCategorySchema }).safeParse(input);
  return decideReply("recategorizeReplyAction", parsed.success, (config, now) => recategorizeReply(getDb(), input.id, { category: parsed.data?.category ?? "other", transitions: config.transitions, now }));
}
