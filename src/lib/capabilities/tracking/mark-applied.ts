import { z } from "zod";

import { trackingWriteOutput } from "@/lib/mcp/dto";

import { defineCapability, WRITE } from "../types";
import { trackingJobId, writeApplicationStatus } from "./set-application-status";
import { trackingWriteAvailability } from "./write-shared";

export const mark_applied = defineCapability({
  id: "mark_applied", kind: "write", permission: "tracking:write",
  input: (ctx) => z.strictObject({ job_id: trackingJobId.describe(ctx.text("params.jobId")) }),
  output: trackingWriteOutput,
  handler: (ctx, args) => writeApplicationStatus(ctx, args),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: WRITE,
  text: { title: "tools.mark_applied.title", description: "tools.mark_applied.description" },
  availability: trackingWriteAvailability,
});
