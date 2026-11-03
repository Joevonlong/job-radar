/**
 * The "what this means for your application" button: snapshot the ticked company background and the chosen stories of a question and
 * leave a `writer_fit` request for the ai-worker. It needs both: without a story there is nothing to meet the company with.
 */
import type { Db } from "@/lib/db/client";
import type { Story, WriterConfig } from "@/lib/config";
import { getApplicationQuestion } from "@/lib/db/repos/application-writer";
import { getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { findOpenFitRequest, getControlRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { fitStoriesHash } from "@/lib/writer/fit-hash";
import { parseSelection } from "@/lib/writer/selection";
import { buildSnapshot, questionSettingsOf } from "@/lib/writer/snapshot";

import { expireScrubbedRequests } from "./expire";
import { readTrapsForWriter, writerRequestState, type WriterRequestOutcome, type WriterRequestState } from "./writer-request";

const log = createProcessLogger({ fields: { component: "control" } });

export async function requestWriterFit(db: Db, input: { jobId: number; questionId: number; writer: WriterConfig | null; stories: readonly Story[] }): Promise<WriterRequestOutcome> {
  const { writer } = input;
  if (writer === null) return { state: "error", error: "config_error" };
  if (!writer.enabled) return { state: "error", error: "disabled" };
  const [job, question] = await Promise.all([getJobForBreakdown(db, input.jobId), getApplicationQuestion(db, { jobId: input.jobId, questionId: input.questionId })]);
  if (!job || !question) return { state: "error", error: "not_found" };
  await expireScrubbedRequests(db, { settings: writer });
  const open = await findOpenFitRequest(db, input.jobId);
  if (open) return { state: "queued", requestId: open.id, existing: true };

  const selection = parseSelection(question.selectedMaterials);
  if (selection.company === null) return { state: "error", error: "no_material" };
  const { materials } = buildSnapshot({
    question: questionSettingsOf(question),
    selection,
    job: { title: job.title, company: job.company },
    jdPoints: [],
    me: null,
    stories: input.stories,
    writer,
    company: await getCompanyResearchForJob(db, input.jobId),
    traps: readTrapsForWriter(),
  });
  if (materials.company === null || materials.stories.length === 0) return { state: "error", error: "no_material" };
  const created = await insertControlRequest(db, {
    kind: "writer_fit",
    payload: {
      jobId: input.jobId,
      questionId: input.questionId,
      materialsHash: fitStoriesHash(materials.stories),
      refs: { storyIds: materials.stories.map((story) => story.id), companyResearchId: materials.company.researchId },
      materials: { job: materials.job, outputLanguage: materials.question.outputLanguage, stories: materials.stories, company: materials.company },
    },
  });
  log.info("manual request queued", { request: created.id, kind: created.kind, jobId: input.jobId });
  return { state: "queued", requestId: created.id, existing: false };
}

/** Where a fit request stands. `jobId` must be the request's job. */
export async function readWriterFitRequest(db: Db, input: { requestId: number; jobId: number }): Promise<WriterRequestState> {
  await expireScrubbedRequests(db);
  const request = await getControlRequest(db, input.requestId);
  const payload = typeof request?.payload === "object" && request.payload !== null ? (request.payload as { jobId?: unknown }) : {};
  if (!request || request.kind !== "writer_fit" || payload.jobId !== input.jobId) return { state: "missing" };
  return writerRequestState(db, request);
}

/** The open fit request of a job, for a page load to go on waiting for. */
export async function openWriterFitRequestId(db: Db, jobId: number): Promise<number | null> {
  return (await findOpenFitRequest(db, jobId))?.id ?? null;
}
