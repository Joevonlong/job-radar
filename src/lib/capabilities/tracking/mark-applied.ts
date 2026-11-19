import { z } from "zod";

import { APPLIED_REFERENCE_MAX } from "@/lib/dashboard/limits";
import { dayInZone, startOfDayInZone } from "@/lib/insights/range";
import type { McpContext } from "@/lib/mcp/context";
import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { trackingJobId, writeApplicationStatus } from "./set-application-status";
import { trackingWriteAvailability } from "./write-shared";

function appliedAtInput(ctx: Pick<McpContext, "text" | "now" | "timezone">) {
  return z.union([z.iso.date(), z.iso.datetime({ offset: true })], { error: ctx.text("errors.appliedAtFormat") })
    .transform((value, validation) => {
      const now = ctx.now();
      if (value.length === 10) {
        try {
          const timezone = ctx.timezone();
          if (value <= dayInZone(now, timezone)) return startOfDayInZone(value, timezone);
        } catch {
          validation.addIssue({ code: "custom", message: ctx.text("errors.appliedAtTimezone") });
          return z.NEVER;
        }
      } else {
        const instant = new Date(value);
        if (instant <= now) return instant;
      }
      validation.addIssue({ code: "custom", message: ctx.text("errors.appliedAtFuture") });
      return z.NEVER;
    });
}

export const mark_applied = defineCapability({
  id: "mark_applied", kind: "write", permission: "tracking:write",
  input: (ctx) => {
    const length = { max: APPLIED_REFERENCE_MAX };
    const referenceError = ctx.text("errors.appliedReferenceLength", length);
    return z.strictObject({
      job_id: trackingJobId.describe(ctx.text("params.jobId")),
      applied_at: appliedAtInput(ctx).optional().describe(ctx.text("params.appliedAt")),
      reference: z.string({ error: referenceError }).trim()
        .refine((value) => value.length > 0 && [...value].length <= APPLIED_REFERENCE_MAX, { error: referenceError })
        .refine((value) => !value.includes("\0"), { error: ctx.text("errors.appliedReferenceNul") })
        .optional().describe(ctx.text("params.appliedReference", length)),
    });
  },
  output: trackingWriteOutput,
  handler: (ctx, args) => writeApplicationStatus(ctx, args),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: WRITE,
  text: { title: "tools.mark_applied.title", description: "tools.mark_applied.description" },
  availability: trackingWriteAvailability,
});
