import { z } from "zod";

import { undoChange } from "@/lib/agent-access/write";
import { applicationUndoKinds } from "@/lib/applications/undo";
import { undoChangeOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { researchNotices, trackingWriteAccess, trackingWriteAvailability, writeFailure } from "../tracking/write-shared";

export const undo_change = defineCapability({
  id: "undo_change", kind: "write", permission: "tracking:write",
  input: (ctx) => z.strictObject({ audit_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.auditId")) }),
  output: undoChangeOutput,
  async handler(ctx, args) {
    const access = trackingWriteAccess(ctx);
    try {
      const result = await undoChange(ctx.tracking!.writeDb!, access, args.audit_id, applicationUndoKinds);
      ctx.auditCall!.committed = true;
      return undoChangeOutput.parse({ notices: researchNotices(ctx, result.research), audit_id: result.auditId, undone_audit_id: args.audit_id, field: result.field, research: result.research });
    } catch (error) { writeFailure(ctx, error); }
  },
  count: () => 1,
  annotations: WRITE,
  text: { title: "tools.undo_change.title", description: "tools.undo_change.description" },
  availability: trackingWriteAvailability,
});
