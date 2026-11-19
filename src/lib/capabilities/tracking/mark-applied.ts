import { z } from "zod";

import { APPLIED_AT_MIN, APPLIED_REFERENCE_MAX } from "@/lib/dashboard/limits";
import { dayInZone, startOfDayInZone } from "@/lib/insights/range";
import type { McpContext } from "@/lib/mcp/context";
import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { trackingJobId, writeApplicationStatus } from "./set-application-status";
import { trackingWriteAvailability } from "./write-shared";

function appliedAtInput(ctx: Pick<McpContext, "text" | "now" | "timezone">) {
  const formatError = ctx.text("errors.appliedAtFormat");
  const rangeError = ctx.text("errors.appliedAtRange", { min: APPLIED_AT_MIN });
  const futureError = ctx.text("errors.appliedAtFuture");
  const earliest = new Date(APPLIED_AT_MIN);
  return z.union([z.iso.date(), z.iso.datetime({ offset: true })], { error: formatError })
    .transform((value, validation) => {
      const invalid = (message: string) => {
        validation.addIssue({ code: "custom", message });
        return z.NEVER;
      };
      const now = ctx.now();
      let instant: Date;
      if (value.length === 10) {
        if (value < APPLIED_AT_MIN.slice(0, 10)) return invalid(rangeError);
        let timezone: string;
        try {
          timezone = ctx.timezone();
        } catch {
          return invalid(ctx.text("errors.appliedAtTimezone"));
        }
        if (value > dayInZone(now, timezone)) return invalid(futureError);
        try {
          instant = startOfDayInZone(value, timezone);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          return invalid(formatError);
        }
        if (dayInZone(instant, timezone) !== value) return invalid(formatError);
      } else {
        instant = new Date(value);
      }
      if (instant < earliest) return invalid(rangeError);
      if (instant > now) return invalid(futureError);
      return instant;
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
