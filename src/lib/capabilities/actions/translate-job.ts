import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { requestTranslateJob } from "@/lib/control/translate-request";

export const translate_job = defineCapability({
  id: "translate_job",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    job_id: z.number().int().positive().describe(ctx.text("params.jobId")),
    force: z.boolean().default(false).describe(ctx.text("params.force")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "translate_job", (db, caller) => requestTranslateJob(db, { jobId: args.job_id, force: args.force, caller, origin: "user" })),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: ADDS_ONLY,
  availability: actionAvailability("translate_job"),
  text: { title: "tools.translate_job.title", description: "tools.translate_job.description" },
});
