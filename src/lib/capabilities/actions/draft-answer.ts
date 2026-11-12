import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction } from "./run-action";
import { writerSchema } from "@/lib/config";
import { requestWriter } from "@/lib/control/writer-request";
import { POLISH_OPTIONS } from "@/lib/writer/types";

export const draft_answer = defineCapability({
  id: "draft_answer",
  kind: "trigger",
  permission: "actions:run",
  alsoRequires: ["writer:write"],
  input: (ctx) => z.strictObject({
    job_id: z.number().int().positive().describe(ctx.text("params.jobId")),
    question_id: z.number().int().positive().describe(ctx.text("params.questionId")),
    mode: z.enum(["draft", "polish"]).describe(ctx.text("params.draftMode")),
    option: z.enum(POLISH_OPTIONS).optional().describe(ctx.text("params.polishOption")),
    text: z.string().trim().min(1).max(ctx.writer?.inputs().writer?.draft_max_chars ?? writerSchema.parse({}).draft_max_chars).optional().describe(ctx.text("params.polishText")),
  }).refine((args) => args.mode === "polish" ? args.option !== undefined && args.text !== undefined : args.option === undefined && args.text === undefined),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "draft_answer", async (db, caller) => {
    const inputs = ctx.writer!.inputs();
    const spec = args.mode === "draft" ? { mode: "draft" as const } : { mode: "polish" as const, option: args.option!, text: args.text! };
    return requestWriter(db, { jobId: args.job_id, questionId: args.question_id, caller, ...inputs }, spec);
  }),
  count: () => 1,
  target: (args) => ({ type: "question", id: args.question_id }),
  annotations: ADDS_ONLY,
  availability: actionAvailability("draft_answer"),
  text: { title: "tools.draft_answer.title", description: "tools.draft_answer.description" },
});
