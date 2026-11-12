import { z } from "zod";

import { notices } from "./shared";

const auditId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const research = z.enum(["off", "recent", "all_cached", "nothing_to_run", "deferred_quota", "cap_reached", "budget_skipped", "queued", "failed"]).nullable();

/** Write receipts contain identifiers and outcomes only, never saved or restored private text. */
export const trackingWriteOutput = z.strictObject({
  notices,
  audit_id: auditId,
  job_id: z.number().int().positive(),
  field: z.enum(["application_status", "next_action", "interview_rounds"]),
  undoable: z.boolean(),
  research,
});

export const undoChangeOutput = z.strictObject({
  notices,
  audit_id: auditId,
  undone_audit_id: auditId,
  field: z.string(),
  research,
});
