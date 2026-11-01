"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { LENGTH_UNITS, QUESTION_KINDS } from "@/lib/config/schemas/writer";
import { readWriterRequest, requestWriterDraft, type WriterErrorCode } from "@/lib/control/writer-request";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { getDb } from "@/lib/db";
import {
  createApplicationQuestion,
  deleteApplicationQuestion,
  getAnswerVersion,
  getApplicationQuestion,
  insertAnswerVersions,
  setFinalAnswerVersion,
  updateApplicationQuestion,
} from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { isLanguageCode } from "@/lib/i18n/languages";
import { logActionFailure } from "@/lib/logging/action-failure";
import { diffSentences } from "@/lib/writer/diff";
import { jdPointsOf } from "@/lib/writer/jd-points";
import { preselectStories } from "@/lib/writer/selection";
import { readWriterInputs } from "@/lib/writer/settings";
import { parseStoredSentences } from "@/lib/writer/stored";
import type { QuestionSelection } from "@/lib/writer/types";
import { countStatuses } from "@/lib/writer/verify";

/**
 * Server Actions of the application writer's workbench. The web app calls no AI provider: "write" leaves a `writer_job`
 * request for the ai-worker and the page polls `writerStatusAction`. Every input is validated (C6) and every write names
 * its job, so an id alone never reaches another job's questions.
 */

const positive = z.number().int().positive();
const language = z.string().min(2).max(35).refine(isLanguageCode, "not a language code");
const selectionSchema = z.strictObject({
  jdPoints: z.array(z.strictObject({ quote: z.string().min(1).max(2000), offset: z.number().int().min(0) })).max(200),
  useJdText: z.boolean(),
  storyIds: z.array(z.string().min(1).max(80)).max(1000),
  profile: z.boolean(),
  emphasis: z.string().max(5000),
});
const settingsSchema = z.strictObject({
  text: z.string().trim().min(1).max(10_000),
  kind: z.enum(QUESTION_KINDS),
  lengthUnit: z.enum(LENGTH_UNITS),
  lengthValue: z.number().int().min(10).max(5000),
  outputLanguage: language,
  tone: z.string().min(1).max(40),
});

export type WriterActionError = "invalid" | "disabled" | "config_error" | "not_found" | "limit" | "too_long" | "failed";
export type WriterActionResult = { ok: true } | { ok: false; error: WriterActionError };

const revalidate = (jobId: number): void => revalidatePath(`/jobs/${jobId}/apply`);

/** The input breaks a writer.yaml length limit. */
function tooLong(input: { text?: string; emphasis?: string }, limits: { text: number; emphasis: number }): boolean {
  return (input.text !== undefined && input.text.length > limits.text) || (input.emphasis !== undefined && input.emphasis.length > limits.emphasis);
}

/** Add a question (or a cover letter) to the job, with the material a new question starts with. */
export async function addQuestionAction(input: { jobId: number; settings: z.input<typeof settingsSchema> }): Promise<WriterActionResult & { questionId?: number }> {
  const parsed = z.strictObject({ jobId: positive, settings: settingsSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const { writer, stories } = readWriterInputs();
    if (writer === null) return { ok: false, error: "config_error" };
    if (!writer.enabled) return { ok: false, error: "disabled" };
    const { jobId, settings } = parsed.data;
    if (!writer.tones.includes(settings.tone)) return { ok: false, error: "invalid" };
    if (tooLong({ text: settings.text }, { text: writer.questions.text_max_chars, emphasis: writer.emphasis_max_chars })) return { ok: false, error: "too_long" };
    const db = getDb();
    const job = await getJobForBreakdown(db, jobId);
    if (!job) return { ok: false, error: "not_found" };
    const breakdown = await getJobBreakdown(db, jobId);
    const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
    const points = content ? jdPointsOf(content) : [];
    const selection: QuestionSelection = {
      // a new question starts with the JD's requirements and the stories that share its skills
      jdPoints: points.filter((point) => point.requirement === "must").map((point) => ({ quote: point.quote, offset: point.offset })),
      useJdText: points.length === 0 && job.description !== null && job.description.trim() !== "",
      storyIds: preselectStories(stories, content?.tech_stack.map((item) => item.name) ?? [], writer.stories.preselect_count),
      profile: true,
      emphasis: "",
    };
    const created = await createApplicationQuestion(db, { maxPerJob: writer.questions.max_per_job, fields: { jobId, ...settings, selectedMaterials: selection } });
    if (!created) return { ok: false, error: "limit" };
    revalidate(jobId);
    return { ok: true, questionId: created.id };
  } catch (error) {
    logActionFailure("addQuestionAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Change a question's text and settings, or its selected material. */
export async function updateQuestionAction(input: { jobId: number; questionId: number; settings?: z.input<typeof settingsSchema>; selection?: QuestionSelection }): Promise<WriterActionResult> {
  const parsed = z.strictObject({ jobId: positive, questionId: positive, settings: settingsSchema.optional(), selection: selectionSchema.optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const { writer } = readWriterInputs();
    if (writer === null) return { ok: false, error: "config_error" };
    const { jobId, questionId, settings, selection } = parsed.data;
    if (settings && !writer.tones.includes(settings.tone)) return { ok: false, error: "invalid" };
    if (tooLong({ ...(settings ? { text: settings.text } : {}), ...(selection ? { emphasis: selection.emphasis } : {}) }, { text: writer.questions.text_max_chars, emphasis: writer.emphasis_max_chars })) {
      return { ok: false, error: "too_long" };
    }
    const updated = await updateApplicationQuestion(getDb(), { jobId, questionId, fields: { ...(settings ?? {}), ...(selection ? { selectedMaterials: selection } : {}) } });
    if (!updated) return { ok: false, error: "not_found" };
    revalidate(jobId);
    return { ok: true };
  } catch (error) {
    logActionFailure("updateQuestionAction", error);
    return { ok: false, error: "failed" };
  }
}

export async function deleteQuestionAction(input: { jobId: number; questionId: number }): Promise<WriterActionResult> {
  const parsed = z.strictObject({ jobId: positive, questionId: positive }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    if (!(await deleteApplicationQuestion(getDb(), parsed.data))) return { ok: false, error: "not_found" };
    revalidate(parsed.data.jobId);
    return { ok: true };
  } catch (error) {
    logActionFailure("deleteQuestionAction", error);
    return { ok: false, error: "failed" };
  }
}

export type WriteErrorKey = "invalid" | WriterErrorCode;
export type WriteActionResult = { ok: true; requestId: number } | { ok: false; error: WriteErrorKey };

/** "Write": snapshot the question's material and queue a `writer_job` request. */
export async function writeAnswerAction(input: { jobId: number; questionId: number }): Promise<WriteActionResult> {
  const parsed = z.strictObject({ jobId: positive, questionId: positive }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const outcome = await requestWriterDraft(getDb(), { ...parsed.data, ...readWriterInputs() });
    if (outcome.state === "error") return { ok: false, error: outcome.error };
    return { ok: true, requestId: outcome.requestId };
  } catch (error) {
    logActionFailure("writeAnswerAction", error);
    return { ok: false, error: "failed" };
  }
}

export type WriterStatusResult =
  /** The state could not be read this time; the browser retries. */
  | null
  | { ok: true; state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { ok: true; state: "done" }
  | { ok: false; error: WriteErrorKey; detail?: string | null; resumeAt?: string | null };

/** State of a queued writing request: still waiting, done (the page is revalidated), or the reason it failed. */
export async function writerStatusAction(input: { jobId: number; requestId: number }): Promise<WriterStatusResult> {
  const parsed = z.strictObject({ jobId: positive, requestId: positive }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const state = await readWriterRequest(getDb(), parsed.data);
    if (state.state === "missing") return { ok: false, error: "not_found" };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, detail: state.detail, resumeAt: state.resumeAt };
    revalidate(parsed.data.jobId);
    return { ok: true, state: "done" };
  } catch (error) {
    logActionFailure("writerStatusAction", error);
    return null;
  }
}

/** Mark a version as the question's final answer, or clear the mark (`versionId: null`). */
export async function setFinalVersionAction(input: { jobId: number; questionId: number; versionId: number | null }): Promise<WriterActionResult> {
  const parsed = z.strictObject({ jobId: positive, questionId: positive, versionId: positive.nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    if (!(await setFinalAnswerVersion(getDb(), parsed.data))) return { ok: false, error: "not_found" };
    revalidate(parsed.data.jobId);
    return { ok: true };
  } catch (error) {
    logActionFailure("setFinalVersionAction", error);
    return { ok: false, error: "failed" };
  }
}

/**
 * Save a hand-edited version: the text is split into sentences again; unchanged sentences keep their check result, the
 * others are `user_written`. The new version becomes the question's newest one.
 */
export async function saveManualVersionAction(input: { jobId: number; questionId: number; parentVersionId: number; text: string }): Promise<WriterActionResult & { versionId?: number }> {
  const parsed = z.strictObject({ jobId: positive, questionId: positive, parentVersionId: positive, text: z.string().trim().min(1).max(50_000) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const { writer } = readWriterInputs();
    if (writer === null) return { ok: false, error: "config_error" };
    const db = getDb();
    const { jobId, questionId, parentVersionId, text } = parsed.data;
    const question = await getApplicationQuestion(db, { jobId, questionId });
    const parent = question ? await getAnswerVersion(db, { questionId, versionId: parentVersionId }) : null;
    if (!question || !parent) return { ok: false, error: "not_found" };
    const sentences = diffSentences(parseStoredSentences(parent.sentences, parent.text), text);
    const counts = countStatuses(sentences);
    const [id] = await insertAnswerVersions(db, {
      questionId,
      maxVersions: writer.questions.max_versions_per_question,
      versions: [
        {
          mode: "manual",
          variantId: parent.variantId,
          text,
          sentences,
          supportedCount: counts.supported,
          partialCount: counts.partial,
          unsupportedCount: counts.unsupported,
          framingCount: counts.framing,
          userWrittenCount: counts.user_written,
          webUnverifiedCount: counts.web_unverified,
          parentVersionId,
          materialsHash: parent.materialsHash,
        },
      ],
    });
    revalidate(jobId);
    return id === undefined ? { ok: true } : { ok: true, versionId: id };
  } catch (error) {
    logActionFailure("saveManualVersionAction", error);
    return { ok: false, error: "failed" };
  }
}
