import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { readSalaryActionSettings } from "@/lib/control/action-settings";
import { requestSalaryLookup } from "@/lib/control/salary-request";

export const research_salary = defineCapability({
  id: "research_salary",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    job_id: z.number().int().positive().describe(ctx.text("params.jobId")),
    force: z.boolean().default(false).describe(ctx.text("params.force")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "research_salary", (db, caller) => requestSalaryLookup(db, { jobId: args.job_id, force: args.force, caller, ...readSalaryActionSettings() })),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: ADDS_ONLY,
  availability: actionAvailability("research_salary"),
  text: { title: "tools.research_salary.title", description: "tools.research_salary.description" },
});
