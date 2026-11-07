import { loadConfig } from "@/lib/config";
import { readCareerGate } from "@/lib/config/career-gate";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { safeErrorCode } from "@/lib/activity/error-codes";
import { expireScrubbedRequests } from "@/lib/control/expire";
import { loadQueueView } from "@/lib/control/queue-view";
import { careerTailorPayloadSchema } from "@/lib/control/types";
import type { Db } from "@/lib/db/client";
import { findLatestCareerTailorRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import { careerDocumentPath } from "../store/paths";
import { loadTailorContext } from "./context";
import { previewOutbound } from "./assemble";
import { readProposals } from "./proposals";
import { z } from "zod";

export async function requestCareerTailor(db: Db, raw: unknown) {
  if (!(await readCareerGate()).enabled) return { state: "error" as const, error: "disabled" as const };
  const parsed = careerTailorPayloadSchema.safeParse(raw);
  if (!parsed.success || parsed.data.mode === "shrink" && (parsed.data.over_pages === null || parsed.data.with_letter)) return { state: "error" as const, error: "invalid" as const };
  const payload = parsed.data;
  const settings = loadConfig("career");
  await expireScrubbedRequests(db, { careerSettings: settings });
  return withFileLock(careerDocumentPath(payload.doc_id), () => withConfigWriteLock(async () => {
    const latest = await findLatestCareerTailorRequest(db, payload.doc_id);
    if (latest && ["pending", "running"].includes(latest.status)) {
      const same = JSON.stringify(careerTailorPayloadSchema.safeParse(latest.payload).data) === JSON.stringify(payload);
      return same ? { state: "queued" as const, requestId: latest.id, existing: true } : { state: "error" as const, error: "busy" as const };
    }
    const { outbound } = await loadTailorContext(db, payload, settings);
    if (outbound.hash !== payload.outbound_hash) return { state: "error" as const, error: "review_again" as const, ...previewOutbound(outbound), doc_id: payload.doc_id };
    const request = await insertControlRequest(db, { kind: "career_tailor", payload });
    return { state: "queued" as const, requestId: request.id, existing: false, replacesProposals: Boolean((await readProposals(payload.doc_id))?.items.length) };
  }, careerDocumentPath(payload.doc_id)));
}

export async function readCareerTailorStatus(db: Db, docId: string) {
  if (!(await readCareerGate()).enabled) return { state: "failed" as const, error: "disabled" };
  await expireScrubbedRequests(db);
  const request = await findLatestCareerTailorRequest(db, docId);
  if (!request) return { state: "missing" as const };
  if (["pending", "running"].includes(request.status)) return { state: "waiting" as const, requestId: request.id, stage: request.status, queue: await loadQueueView(db, request) };
  const result = z.object({ error: z.string().optional(), proposals: z.number().int().nonnegative().optional(), dropped: z.number().int().nonnegative().optional(), flagged: z.number().int().nonnegative().optional() }).safeParse(request.result);
  if (request.status === "failed") return { state: "failed" as const, error: safeErrorCode(result.success ? result.data.error : undefined) };
  return { state: "done" as const, proposals: result.success ? result.data.proposals ?? 0 : 0, dropped: result.success ? result.data.dropped ?? 0 : 0, flagged: result.success ? result.data.flagged ?? 0 : 0 };
}
