import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { readBreakdownSettings } from "@/lib/breakdown/settings";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";

export const breakdown_job = defineCapability({
  id: "breakdown_job",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    job_id: z.number().int().positive().describe(ctx.text("params.jobId")),
    force: z.boolean().default(false).describe(ctx.text("params.force")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "breakdown_job", (db, caller) => requestBreakdownJob(db, { jobId: args.job_id, force: args.force, caller, settings: readBreakdownSettings() })),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: ADDS_ONLY,
  availability: actionAvailability("breakdown_job"),
  text: { title: "tools.breakdown_job.title", description: "tools.breakdown_job.description" },
});
