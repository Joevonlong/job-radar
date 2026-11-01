/**
 * Web side of the application writer's "write" button: the web app never calls an AI provider. It takes the snapshot
 * of the question's material, leaves a `writer_job` request for the ai-worker and then asks for its state. Every read
 * first fails the expired requests of the scrubbed kinds (`expireScrubbedRequests`), so a request's material is cleared
 * on time even while no ai-worker runs. Server only; `app/jobs/[id]/apply/actions.ts` calls it.
 */
import { parseStoredBreakdown } from "@/lib/breakdown/content";
import type { MeConfig, Story, WriterConfig } from "@/lib/config";
import type { LengthUnit, QuestionKind } from "@/lib/config/schemas/writer";
import type { Db } from "@/lib/db/client";
import { getApplicationQuestion } from "@/lib/db/repos/application-writer";
import { getJobBreakdown, getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { findLatestWriterRequests, findOpenWriterRequest, getControlRequest, insertControlRequest, type ControlRequest } from "@/lib/db/repos/control-requests";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";
import { materialsHash } from "@/lib/writer/hash";
import { jdPointsOf } from "@/lib/writer/jd-points";
import { writeInputFields } from "@/lib/writer/materials";
import { parseSelection } from "@/lib/writer/selection";
import { buildSnapshot } from "@/lib/writer/snapshot";

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
  | { state: "error"; error: "disabled" | "config_error" | "not_found" | "no_material" };

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
  const { writer } = input;
  if (writer === null) return { state: "error", error: "config_error" };
  if (!writer.enabled) return { state: "error", error: "disabled" };
  const [job, question] = await Promise.all([getJobForBreakdown(db, input.jobId), getApplicationQuestion(db, { jobId: input.jobId, questionId: input.questionId })]);
  if (!job || !question) return { state: "error", error: "not_found" };
  await expireScrubbedRequests(db, { timeoutSeconds: writer.timeout_seconds });
  const open = await findOpenWriterRequest(db, { jobId: input.jobId, questionId: input.questionId });
  if (open) return { state: "queued", requestId: open.id, existing: true };

  const breakdown = await getJobBreakdown(db, input.jobId);
  const content = breakdown ? parseStoredBreakdown(breakdown.promptVersion, breakdown.content) : null;
  const selection = parseSelection(question.selectedMaterials);
  const { materials } = buildSnapshot({
    question: {
      text: question.text,
      kind: question.kind as QuestionKind,
      lengthUnit: question.lengthUnit as LengthUnit,
      lengthValue: question.lengthValue,
      outputLanguage: question.outputLanguage,
      tone: question.tone,
    },
    selection: { ...selection, useJdText: selection.useJdText && job.description !== null && job.description.trim() !== "" },
    job: { title: job.title, company: job.company },
    jdPoints: content ? jdPointsOf(content) : [],
    me: input.me,
    stories: input.stories,
    writer,
  });
  // the question, its settings and the job alone are no material to write from
  if (writeInputFields(materials).length <= 3) return { state: "error", error: "no_material" };
  const payload = {
    jobId: input.jobId,
    questionId: input.questionId,
    mode: "draft" as const,
    materialsHash: materialsHash(materials),
    refs: { storyIds: materials.stories.map((story) => story.id), jdPoints: materials.jdPoints.length, profile: materials.profile !== null, emphasis: materials.emphasis !== null },
    materials,
  };
  const created = await insertControlRequest(db, { kind: "writer_job", payload });
  log.info("manual request queued", { request: created.id, kind: created.kind, jobId: input.jobId });
  return { state: "queued", requestId: created.id, existing: false };
}

export type WriterRequestState =
  | { state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { state: "done" }
  | { state: "failed"; error: WriterErrorCode; detail: string | null; resumeAt: string | null }
  /** There is no such request, or it is not this job's. */
  | { state: "missing" };

const payloadOf = (request: ControlRequest): { jobId?: unknown; questionId?: unknown } =>
  typeof request.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown; questionId?: unknown }) : {};

async function stateOf(db: Db, request: ControlRequest): Promise<Exclude<WriterRequestState, { state: "missing" }>> {
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
  return stateOf(db, request);
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
    const state = await stateOf(db, request);
    if (state.state === "waiting") out.set(questionId, { state: "waiting", requestId: request.id, stage: state.stage, queue: state.queue });
    if (state.state !== "failed") continue;
    const newest = newestVersionAt.get(questionId);
    if (newest !== undefined && request.finishedAt !== null && request.finishedAt <= newest) continue;
    out.set(questionId, state);
  }
  return out;
}
