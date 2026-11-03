/**
 * Web side of the application writer's "write" button: the web app never calls an AI provider. It takes the snapshot
 * of the question's material, leaves a `writer_job` request for the ai-worker and then asks for its state. Every read
 * first fails the expired requests of the scrubbed kinds (`expireScrubbedRequests`), so a request's material is cleared
 * on time even while no ai-worker runs. Server only; `app/jobs/[id]/apply/actions.ts` calls it.
 */
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import { ConfigError, reloadConfig, type MeConfig, type Story, type TrapsConfig, type WriterConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getAnswerVersion, getApplicationQuestion } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { findLatestWriterRequests, findOpenWriterRequest, getControlRequest, insertWriterRequestUnlessOpen, type ControlRequest } from "@/lib/db/repos/control-requests";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";
import { aiOutputLanguage } from "@/lib/i18n/config";
import { parseStoredCoach, trustedDraftText } from "@/lib/writer/coach";
import { materialsHash } from "@/lib/writer/hash";
import { jdPointsOf } from "@/lib/writer/jd-points";
import { writeInputFields } from "@/lib/writer/materials";
import { COACH_REWRITE_VARIANT, EMPTY_SELECTION, type PolishOption, type QuestionSelection, type WriteMode } from "@/lib/writer/types";
import { parseSelection } from "@/lib/writer/selection";
import { parseStoredSentences } from "@/lib/writer/stored";
import { buildSnapshot, questionSettingsOf } from "@/lib/writer/snapshot";

import { expireScrubbedRequests } from "./expire";
import { loadQueueView } from "./queue-view";
import { resumeAtOf, type ControlQueueView } from "./request-view-schema";

const log = createProcessLogger({ fields: { component: "control" } });

/** Error codes the workbench has labels for: the AI failure classes plus the request-level ones. */
export const WRITER_ERROR_CODES = [
  ...TRANSLATION_FAILURE_CODES,
  "disabled",
  "config_error",
  "not_found",
  "no_material",
  "too_long",
  "busy",
  "expired",
  "output_truncated",
  "aborted",
  "invalid_payload",
  "handler_error",
  "no_handler",
] as const;
export type WriterErrorCode = (typeof WRITER_ERROR_CODES)[number];

export type WriterRequestOutcome =
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "error"; error: "disabled" | "config_error" | "not_found" | "no_material" | "too_long" | "busy" };

/** What a request asks for: drafts from the material, a polish of your text, a review of a version, or a rewrite after a review. */
export type WriterRequestSpec =
  | { mode: "draft" }
  | { mode: "polish"; option: PolishOption; text: string }
  | { mode: "coach"; versionId: number }
  | { mode: "coach_rewrite"; versionId: number };


export interface WriterRequestInput {
  jobId: number;
  questionId: number;
  /** null: writer.yaml cannot be read. */
  writer: WriterConfig | null;
  /** null: me.yaml cannot be read (the profile is then not sent). */
  me: MeConfig | null;
  stories: readonly Story[];
}

export async function requestWriterDraft(db: Db, input: WriterRequestInput): Promise<WriterRequestOutcome> {
  return requestWriter(db, input, { mode: "draft" });
}

/** traps.yaml as it is now, or null while it cannot be read. */
export function readTrapsForWriter(): TrapsConfig | null {
  try {
    return reloadConfig("traps");
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** The selection a request sends: "language only" sends none of the material, only your text. */
function selectionFor(spec: WriterRequestSpec, chosen: QuestionSelection): QuestionSelection {
  return spec.mode === "polish" && spec.option === "language_only" ? { ...EMPTY_SELECTION, profile: false } : chosen;
}

/** Asking to write again joins the running write; anything else (your text, a review) would be dropped silently, so say so. */
function joinOpenRequest(open: ControlRequest, spec: WriterRequestSpec): WriterRequestOutcome {
  const openMode = typeof open.payload === "object" && open.payload !== null ? (open.payload as { mode?: unknown }).mode : undefined;
  if (spec.mode === "draft" && (openMode === undefined || openMode === "draft")) return { state: "queued", requestId: open.id, existing: true };
  return { state: "error", error: "busy" };
}

/**
 * Snapshot the question's material (and, to polish or review, the text to work on) and leave a `writer_job` request for the
 * ai-worker. A question has one open request at a time: asking again joins it.
 */
export async function requestWriter(db: Db, input: WriterRequestInput, spec: WriterRequestSpec): Promise<WriterRequestOutcome> {
  const { writer } = input;
  if (writer === null) return { state: "error", error: "config_error" };
  if (!writer.enabled) return { state: "error", error: "disabled" };
  const [job, question] = await Promise.all([getJobForBreakdown(db, input.jobId), getApplicationQuestion(db, { jobId: input.jobId, questionId: input.questionId })]);
  if (!job || !question) return { state: "error", error: "not_found" };
  await expireScrubbedRequests(db, { settings: writer });
  const open = await findOpenWriterRequest(db, { jobId: input.jobId, questionId: input.questionId });
  if (open) return joinOpenRequest(open, spec);

  const breakdown = await getJobBreakdown(db, input.jobId);
  const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
  const chosen = parseSelection(question.selectedMaterials);
  const selection = selectionFor(spec, chosen);
  let draft: Parameters<typeof buildSnapshot>[0]["draft"];
  if (spec.mode === "polish") {
    const text = spec.text.trim();
    if (text === "") return { state: "error", error: "no_material" };
    if (text.length > writer.draft_max_chars) return { state: "error", error: "too_long" };
    draft = { snapshot: { text, sentences: [], suggestions: [], notesLanguage: "en", evidenceText: null }, variants: [{ id: spec.option, hint: spec.option }] };
  } else if (spec.mode !== "draft") {
    const version = await getAnswerVersion(db, { questionId: input.questionId, versionId: spec.versionId });
    if (!version) return { state: "error", error: "not_found" };
    const checked = parseStoredSentences(version.sentences, version.text);
    const sentences = checked.map((sentence) => sentence.text);
    const suggestions = spec.mode === "coach_rewrite" ? (parseStoredCoach(version.coach)?.suggestions ?? []) : [];
    if (spec.mode === "coach_rewrite" && suggestions.length === 0) return { state: "error", error: "no_material" };
    if (version.text.length > writer.draft_max_chars) return { state: "error", error: "too_long" };
    draft = {
      snapshot: {
        text: version.text,
        sentences,
        suggestions: suggestions.map((suggestion) => ({ index: suggestion.sentenceIndex, issue: suggestion.issue, rewrite: suggestion.sentence.text })),
        notesLanguage: aiOutputLanguage(),
        evidenceText: trustedDraftText(checked),
      },
      variants: spec.mode === "coach_rewrite" ? [{ id: COACH_REWRITE_VARIANT, hint: "rewrite after the review" }] : [],
    };
  }
  const { materials } = buildSnapshot({
    question: questionSettingsOf(question),
    selection: { ...selection, useJdText: selection.useJdText && job.description !== null && job.description.trim() !== "" },
    job: { title: job.title, company: job.company },
    jdPoints: content ? jdPointsOf(content) : [],
    me: input.me,
    stories: input.stories,
    writer,
    draft,
    // only ticked background is read for the request; an unticked one stays out
    company: selection.company === null ? null : await getCompanyResearchForJob(db, input.jobId),
    traps: selection.company === null ? null : readTrapsForWriter(),
  });
  // the question, its settings and the job alone are no material to write from
  if (writeInputFields(materials).length <= 3) return { state: "error", error: "no_material" };
  const payload = {
    jobId: input.jobId,
    questionId: input.questionId,
    mode: spec.mode satisfies WriteMode,
    ...(spec.mode === "polish" ? { polish: spec.option } : {}),
    ...(spec.mode === "coach" || spec.mode === "coach_rewrite" ? { versionId: spec.versionId } : {}),
    materialsHash: materialsHash(materials),
    refs: {
      storyIds: materials.stories.map((story) => story.id),
      jdPoints: materials.jdPoints.length,
      profile: materials.profile !== null,
      emphasis: materials.emphasis !== null,
      draft: materials.draft !== null,
      companyResearchId: materials.company?.researchId ?? null,
    },
    materials,
  };
  // a second click may have got here too: the check above only saves building the snapshot
  const { request, created } = await insertWriterRequestUnlessOpen(db, { jobId: input.jobId, questionId: input.questionId, payload });
  if (!created) return joinOpenRequest(request, spec);
  log.info("manual request queued", { request: request.id, kind: request.kind, jobId: input.jobId });
  return { state: "queued", requestId: request.id, existing: false };
}

export type WriterRequestState =
  | { state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { state: "done" }
  | { state: "failed"; error: WriterErrorCode; detail: string | null; resumeAt: string | null }
  /** There is no such request, or it is not this job's. */
  | { state: "missing" };

const payloadOf = (request: ControlRequest): { jobId?: unknown; questionId?: unknown } =>
  typeof request.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown; questionId?: unknown }) : {};

export async function writerRequestState(db: Db, request: ControlRequest): Promise<Exclude<WriterRequestState, { state: "missing" }>> {
  if (request.status === "pending" || request.status === "running") return { state: "waiting", stage: request.status, queue: await loadQueueView(db, request) };
  if (request.status === "failed") {
    const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; detail?: unknown; resumeAt?: unknown }) : {};
    return {
      state: "failed",
      error: WRITER_ERROR_CODES.find((code) => code === result.error) ?? "failed",
      detail: typeof result.detail === "string" ? result.detail : null,
      resumeAt: resumeAtOf(result.resumeAt),
    };
  }
  return { state: "done" };
}

/** Where a writing request stands. `jobId` must be the request's job: a request id alone never reveals another job's request. */
export async function readWriterRequest(db: Db, input: { requestId: number; jobId: number }): Promise<WriterRequestState> {
  await expireScrubbedRequests(db);
  const request = await getControlRequest(db, input.requestId);
  if (!request || request.kind !== "writer_job" || payloadOf(request).jobId !== input.jobId) return { state: "missing" };
  return writerRequestState(db, request);
}

/** What a question's write button starts with after a page load (absent: nothing to resume). */
export type InitialWriterRequest =
  | { state: "waiting"; requestId: number; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { state: "failed"; error: WriterErrorCode; detail: string | null; resumeAt: string | null };

/**
 * The open or failed request of each question of the job, by question id. A failure older than the question's newest
 * version (`newestVersionAt`) is not shown again.
 */
export async function readInitialWriterRequests(db: Db, jobId: number, newestVersionAt: ReadonlyMap<number, Date>): Promise<Map<number, InitialWriterRequest>> {
  await expireScrubbedRequests(db);
  const out = new Map<number, InitialWriterRequest>();
  for (const [questionId, request] of await findLatestWriterRequests(db, jobId)) {
    const state = await writerRequestState(db, request);
    if (state.state === "waiting") out.set(questionId, { state: "waiting", requestId: request.id, stage: state.stage, queue: state.queue });
    if (state.state !== "failed") continue;
    const newest = newestVersionAt.get(questionId);
    if (newest !== undefined && request.finishedAt !== null && request.finishedAt <= newest) continue;
    out.set(questionId, state);
  }
  return out;
}
