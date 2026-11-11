import { z } from "zod";

import { writeWithUndo } from "@/lib/agent-access/write";
import { changeApplicationStatus, markApplied } from "@/lib/applications/service";
import { applicationUndoKinds } from "@/lib/applications/undo";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";
import { ToolFailure, type McpContext } from "@/lib/mcp/context";
import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { researchNotices, trackingWriteAccess, trackingWriteAvailability, writeFailure } from "./write-shared";

export const trackingJobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export async function writeApplicationStatus(ctx: McpContext, input: { job_id: number; status?: typeof APPLICATION_STATUSES[number] }) {
  const access = trackingWriteAccess(ctx);
  try {
    const result = await writeWithUndo(ctx.tracking!.writeDb!, { access, registry: applicationUndoKinds, kind: "application_status", target: { type: "job", id: input.job_id } }, async (tx) => {
      const change = input.status === undefined
        ? await markApplied(tx, { jobId: input.job_id }, access.caller)
        : await changeApplicationStatus(tx, { jobId: input.job_id, status: input.status }, access.caller);
      if (!change.ok) throw new ToolFailure(change.error, ctx.text(change.error === "not_allowed" ? "errors.markAppliedNotAllowed" : "errors.trackingNotFound"));
      return change;
    });
    ctx.auditCall!.committed = true;
    return trackingWriteOutput.parse({ notices: researchNotices(ctx, result.result.research), audit_id: result.auditId, job_id: input.job_id, field: "application_status", undoable: result.undoable, research: result.result.research });
  } catch (error) { writeFailure(ctx, error); }
}

export const set_application_status = defineCapability({
  id: "set_application_status", kind: "write", permission: "tracking:write",
  input: (ctx) => z.strictObject({ job_id: trackingJobId.describe(ctx.text("params.jobId")), status: z.enum(APPLICATION_STATUSES).describe(ctx.text("params.applicationStatus")) }),
  output: trackingWriteOutput,
  handler: (ctx, args) => writeApplicationStatus(ctx, args),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: WRITE,
  text: { title: "tools.set_application_status.title", description: "tools.set_application_status.description" },
  availability: trackingWriteAvailability,
});
