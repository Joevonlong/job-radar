import { z } from "zod";

import { writeWithUndo } from "@/lib/agent-access/write";
import { setInterviewRounds } from "@/lib/applications/service";
import { applicationUndoKinds } from "@/lib/applications/undo";
import { INTERVIEW_ROUNDS_MAX } from "@/lib/dashboard/limits";
import { ToolFailure } from "@/lib/mcp/context";
import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { trackingJobId } from "./set-application-status";
import { trackingWriteAccess, trackingWriteAvailability, writeFailure } from "./write-shared";

export const set_interview_rounds = defineCapability({
  id: "set_interview_rounds", kind: "write", permission: "tracking:write",
  input: (ctx) => z.strictObject({ job_id: trackingJobId.describe(ctx.text("params.jobId")), rounds: z.number().int().min(0).max(INTERVIEW_ROUNDS_MAX).describe(ctx.text("params.interviewRounds")) }),
  output: trackingWriteOutput,
  async handler(ctx, args) {
    const access = trackingWriteAccess(ctx);
    try {
      const result = await writeWithUndo(ctx.tracking!.writeDb!, { access, registry: applicationUndoKinds, kind: "interview_rounds", target: { type: "job", id: args.job_id } }, async (tx) => {
        const rounds = await setInterviewRounds(tx, { jobId: args.job_id, rounds: args.rounds }, access.caller);
        if (rounds === null) throw new ToolFailure("not_found", ctx.text("errors.trackingNotFound"));
      });
      ctx.auditCall!.committed = true;
      return trackingWriteOutput.parse({ notices: [], audit_id: result.auditId, job_id: args.job_id, field: "interview_rounds", undoable: result.undoable, research: null });
    } catch (error) { writeFailure(ctx, error); }
  },
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: { ...WRITE, openWorldHint: false },
  text: { title: "tools.set_interview_rounds.title", description: "tools.set_interview_rounds.description" },
  availability: trackingWriteAvailability,
});
