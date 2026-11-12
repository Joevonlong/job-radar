import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { readCompanyActionSettings } from "@/lib/control/action-settings";
import { requestCompanyResearch } from "@/lib/control/company-research-request";

export const research_company = defineCapability({
  id: "research_company",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    job_id: z.number().int().positive().describe(ctx.text("params.jobId")),
    force: z.boolean().default(false).describe(ctx.text("params.force")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "research_company", (db, caller) => requestCompanyResearch(db, { jobId: args.job_id, force: args.force, caller, ...readCompanyActionSettings() })),
  count: () => 1,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: ADDS_ONLY,
  availability: actionAvailability("research_company"),
  text: { title: "tools.research_company.title", description: "tools.research_company.description" },
});
