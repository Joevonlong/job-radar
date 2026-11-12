import { z } from "zod";

import { writeWithUndo } from "@/lib/agent-access/write";
import { setNextAction } from "@/lib/applications/service";
import { applicationUndoKinds } from "@/lib/applications/undo";
import { nextActionDateToTimestamp } from "@/lib/dashboard/board";
import { NEXT_ACTION_MAX_CHARS } from "@/lib/dashboard/limits";
import { isCalendarDate } from "@/lib/jobs/search-params";
import { ToolFailure } from "@/lib/mcp/context";
import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { trackingJobId } from "./set-application-status";
import { trackingWriteAccess, trackingWriteAvailability, writeFailure } from "./write-shared";

export const set_next_action = defineCapability({
  id: "set_next_action", kind: "write", permission: "tracking:write",
  input: (ctx) => z.strictObject({
    job_id: trackingJobId.describe(ctx.text("params.jobId")),
    next_action: z.string().max(NEXT_ACTION_MAX_CHARS).describe(ctx.text("params.nextAction")),
    next_action_date: z.string().refine((value) => value === "" || isCalendarDate(value)).nullable().describe(ctx.text("params.nextActionDate")),
  }),
  output: trackingWriteOutput,
  async handler(ctx, args) {
    const access = trackingWriteAccess(ctx);
    try {
      const result = await writeWithUndo(ctx.tracking!.writeDb!, { access, registry: applicationUndoKinds, kind: "next_action", target: { type: "job", id: args.job_id } }, async (tx) => {
        const found = await setNextAction(tx, { jobId: args.job_id, nextAction: args.next_action.trim() || null, nextActionAt: args.next_action_date ? nextActionDateToTimestamp(args.next_action_date) : null }, access.caller);
        if (!found) throw new ToolFailure("not_found", ctx.text("errors.trackingNotFound"));
      });
      ctx.auditCall!.committed = true;
      return trackingWriteOutput.parse({ notices: [], audit_id: result.auditId, job_id: args.job_id, field: "next_action", undoable: result.undoable, research: null });
    } catch (error) { writeFailure(ctx, error); }
  },
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: { ...WRITE, openWorldHint: false },
  text: { title: "tools.set_next_action.title", description: "tools.set_next_action.description" },
  availability: trackingWriteAvailability,
});
