import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction, controlOutcome } from "./run-action";
import { reloadConfig } from "@/lib/config";
import { requestScoreJobs } from "@/lib/control/service";
import { SCORE_JOBS_MAX_IDS } from "@/lib/control/types";

export const score_jobs = defineCapability({
  id: "score_jobs",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    job_ids: z.array(z.number().int().positive()).min(1).max(SCORE_JOBS_MAX_IDS).optional().describe(ctx.text("params.jobIds")),
    backlog: z.literal(true).optional().describe(ctx.text("params.backlog")),
  }).refine((args) => (args.job_ids !== undefined) !== (args.backlog === true)),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "score_jobs", async (db, caller) => controlOutcome(await requestScoreJobs(args.job_ids ? { jobIds: args.job_ids } : { backlog: true }, { db, caller })), { units: args.job_ids?.length ?? Math.max(1, reloadConfig("ai").scoring.backlog_per_run) }),
  count: () => 1,
  annotations: ADDS_ONLY,
  availability: actionAvailability("score_jobs"),
  text: { title: "tools.score_jobs.title", description: "tools.score_jobs.description" },
});
