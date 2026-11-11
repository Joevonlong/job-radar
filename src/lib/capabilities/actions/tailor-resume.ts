import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { requestAgentCareerTailor } from "@/lib/career/tailor/agent-request";
import { careerTailorPayloadSchema } from "@/lib/control/types";

export const tailor_resume = defineCapability({
  id: "tailor_resume",
  kind: "trigger",
  permission: "actions:run",
  alsoRequires: ["career:write"],
  input: (ctx) => z.strictObject({
    doc_id: careerTailorPayloadSchema.shape.doc_id.describe(ctx.text("params.docId")),
    job_id: z.number().int().positive().optional().describe(ctx.text("params.jobId")),
    with_letter: z.boolean().default(false).describe(ctx.text("params.withLetter")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "tailor_resume", (db, caller) => requestAgentCareerTailor(db, args, caller), { notices: [ctx.text("notice.tailorProposals")] }),
  count: () => 1,
  annotations: ADDS_ONLY,
  availability: actionAvailability("tailor_resume"),
  text: { title: "tools.tailor_resume.title", description: "tools.tailor_resume.description" },
});
