import { createHash } from "node:crypto";
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { expireScrubbedRequests } from "@/lib/control/expire";
import { loadQueueView } from "@/lib/control/queue-view";
import type { Db } from "@/lib/db/client";
import { findLatestCareerExtractRequest, getControlRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { safeErrorCode } from "@/lib/activity/error-codes";
import { scrubCareerFinal } from "../contact/scrub";
import { careerProfilePath } from "../store/paths";
import { listPendingCareerDrafts } from "./draft-store";
import { neutralizeCareerSource } from "../ai/source";

export const careerExtractInputSchema = z.strictObject({ origin: z.enum(["resume", "self_description"]), text: z.string() });
export type CareerExtractOutcome = { state: "queued"; requestId: number; existing: boolean } | { state: "error"; error: "disabled" | "invalid" | "no_text" | "too_long" | "review_again" | "too_many" | "busy"; text?: string };

export async function requestCareerExtract(db: Db, raw: unknown): Promise<CareerExtractOutcome> {
  if (!(await readCareerGate()).enabled) return { state: "error", error: "disabled" };
  const parsed = careerExtractInputSchema.safeParse(raw);
  if (!parsed.success) return { state: "error", error: "invalid" };
  const settings = loadConfig("career");
  const { text, origin } = parsed.data;
  if (text.trim().length < settings.import.min_chars) return { state: "error", error: "no_text" };
  if (text.length > settings.import.max_chars) return { state: "error", error: "too_long" };
  const final = scrubCareerFinal(text);
  final.text = neutralizeCareerSource(final.text);
  if (final.text !== text) return { state: "error", error: "review_again", text: final.text };
  const sourceHash = createHash("sha256").update(text).digest("hex");
  await expireScrubbedRequests(db, { careerSettings: settings });
  return withFileLock(careerProfilePath(), () => withConfigWriteLock(async () => {
    const latest = await findLatestCareerExtractRequest(db);
    if (latest && (latest.status === "pending" || latest.status === "running")) {
      const same = z.object({ sourceHash: z.literal(sourceHash) }).safeParse(latest.payload).success;
      return same ? { state: "queued", requestId: latest.id, existing: true } : { state: "error", error: "busy" };
    }
    if ((await listPendingCareerDrafts()).length >= settings.import.max_pending_drafts) return { state: "error", error: "too_many" };
    const request = await insertControlRequest(db, { kind: "career_extract", payload: { origin, text, sourceHash, sourceChars: text.length } });
    return { state: "queued", requestId: request.id, existing: false };
  }, careerProfilePath()));
}

/** Status never exposes the source payload or a provider's diagnostic text. */
export async function readCareerExtractStatus(db: Db, requestId?: number) {
  if (!(await readCareerGate()).enabled) return { state: "failed" as const, error: "disabled" };
  await expireScrubbedRequests(db);
  const request = requestId === undefined ? await findLatestCareerExtractRequest(db) : await getControlRequest(db, requestId);
  if (!request || request.kind !== "career_extract") return { state: "missing" as const };
  if (request.status === "pending" || request.status === "running") return { state: "waiting" as const, requestId: request.id, stage: request.status, queue: await loadQueueView(db, request) };
  const result = z.object({ error: z.string().optional(), entries: z.number().int().nonnegative().optional(), flagged: z.number().int().nonnegative().optional() }).safeParse(request.result);
  if (request.status === "failed") return { state: "failed" as const, error: safeErrorCode(result.success ? result.data.error : undefined) };
  return { state: "done" as const, entries: result.success ? result.data.entries ?? 0 : 0, flagged: result.success ? result.data.flagged ?? 0 : 0 };
}
