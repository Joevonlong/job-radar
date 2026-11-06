/**
 * Web side of story extraction: the web app never calls an AI provider. It leaves a `story_extract` request with the source
 * text for the ai-worker and asks for its state. Every read first fails the expired requests of the scrubbed kinds, so the
 * text is cleared on time even while no ai-worker runs. Server only.
 */
import { createHash } from "node:crypto";

import type { MeConfig, WriterConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { findLatestStoryExtractRequest, getControlRequest, insertControlRequest, type ControlRequest } from "@/lib/db/repos/control-requests";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { NO_STORED_VALUES } from "@/lib/outbound/outbound";
import { scrubFinal, previewHighlights, type Highlight } from "@/lib/outbound/scrub";
import { neutralizeStorySource } from "@/lib/stories/source";
import type { StoryExtractOrigin } from "@/lib/stories/extract";
import { TRANSLATION_FAILURE_CODES } from "@/lib/translation/errors";

import { expireScrubbedRequests } from "./expire";
import { loadQueueView } from "./queue-view";
import { resumeAtOf, type ControlQueueView } from "./request-view-schema";
import type { StoryExtractPayload } from "./types";

const log = createProcessLogger({ fields: { component: "control" } });

/** Error codes the stories card has labels for. */
export const STORY_EXTRACT_ERROR_CODES = [...TRANSLATION_FAILURE_CODES, "disabled", "config_error", "expired", "output_truncated", "aborted", "invalid_payload", "handler_error", "no_handler", "review_again", "too_long", "scrub_mismatch", "preview_required"] as const;
export type StoryExtractErrorCode = (typeof STORY_EXTRACT_ERROR_CODES)[number];

export type StoryExtractOutcome =
  | { state: "queued"; requestId: number; existing: boolean; truncated: false }
  | { state: "error"; error: "disabled" | "config_error" | "no_text" | "busy" | "too_long" | "review_again"; text?: string; highlights?: Highlight[] };

/** The text a "from profile" extraction sends: your summary and skills, nothing else of me.yaml. */
export function profileSourceText(me: Pick<MeConfig, "summary" | "skills">): string {
  const skills = me.skills.map((skill) => skill.name).join(", ");
  return [me.summary.trim(), skills === "" ? "" : `Skills: ${skills}`].filter((part) => part !== "").join("\n\n");
}

const isOpen = (request: ControlRequest): boolean => request.status === "pending" || request.status === "running";

const hashOf = (request: ControlRequest): unknown => (typeof request.payload === "object" && request.payload !== null ? (request.payload as { sourceHash?: unknown }).sourceHash : undefined);

/**
 * Leave a confirmed `story_extract` request without changing its text. One extraction runs at a time: the same text
 * joins the open request, another one is refused rather than queued next to it.
 */
export async function requestStoryExtract(db: Db, input: { origin: StoryExtractOrigin; text: string; writer: WriterConfig | null }): Promise<StoryExtractOutcome> {
  const { writer } = input;
  if (writer === null) return { state: "error", error: "config_error" };
  if (!writer.enabled) return { state: "error", error: "disabled" };
  const { text } = input;
  if (text.trim().length < writer.import.min_chars) return { state: "error", error: "no_text" };
  if (text.length > writer.import.max_chars) return { state: "error", error: "too_long" };
  const final = neutralizeStorySource(scrubFinal(text, NO_STORED_VALUES).text);
  if (final !== text) return {
    state: "error", error: "review_again", text: final,
    highlights: previewHighlights(final, NO_STORED_VALUES, writer.import),
  };
  const truncated = false;
  const sourceHash = createHash("sha256").update(text).digest("hex");
  await expireScrubbedRequests(db, { settings: writer });
  const latest = await findLatestStoryExtractRequest(db);
  if (latest && isOpen(latest)) {
    if (hashOf(latest) === sourceHash) return { state: "queued", requestId: latest.id, existing: true, truncated };
    return { state: "error", error: "busy" };
  }
  const payload: StoryExtractPayload = { origin: input.origin, sourceHash, sourceChars: text.length, truncated, text, confirmed: true };
  const created = await insertControlRequest(db, { kind: "story_extract", payload });
  log.info("story extraction queued", { request: created.id, origin: input.origin, chars: text.length, truncated });
  return { state: "queued", requestId: created.id, existing: false, truncated };
}

export type StoryExtractState =
  | { state: "waiting"; stage: "pending" | "running"; queue: ControlQueueView | null }
  | { state: "done"; drafts: number }
  | { state: "failed"; error: StoryExtractErrorCode; resumeAt: string | null }
  | { state: "missing" };

async function stateOf(db: Db, request: ControlRequest): Promise<Exclude<StoryExtractState, { state: "missing" }>> {
  if (isOpen(request)) return { state: "waiting", stage: request.status as "pending" | "running", queue: await loadQueueView(db, request) };
  const result = typeof request.result === "object" && request.result !== null ? (request.result as { error?: unknown; resumeAt?: unknown; drafts?: unknown }) : {};
  if (request.status === "failed") {
    return { state: "failed", error: STORY_EXTRACT_ERROR_CODES.find((code) => code === result.error) ?? "failed", resumeAt: resumeAtOf(result.resumeAt) };
  }
  return { state: "done", drafts: typeof result.drafts === "number" ? result.drafts : 0 };
}

/** Where an extraction stands. */
export async function readStoryExtractRequest(db: Db, requestId: number): Promise<StoryExtractState> {
  await expireScrubbedRequests(db);
  const request = await getControlRequest(db, requestId);
  if (!request || request.kind !== "story_extract") return { state: "missing" };
  return stateOf(db, request);
}

/** What the card starts with after a page load: the open extraction, to follow it. A failure is shown only by the page that started it. */
export async function readOpenStoryExtract(db: Db): Promise<{ requestId: number; stage: "pending" | "running"; queue: ControlQueueView | null } | null> {
  await expireScrubbedRequests(db);
  const latest = await findLatestStoryExtractRequest(db);
  if (!latest || !isOpen(latest)) return null;
  return { requestId: latest.id, stage: latest.status as "pending" | "running", queue: await loadQueueView(db, latest) };
}
