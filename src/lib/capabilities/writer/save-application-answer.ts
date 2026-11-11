import { saveApplicationAnswerOutput } from "@/lib/mcp/dto";
import { saveApplicationAnswer, saveApplicationAnswerInput } from "@/lib/mcp/tools/save-application-answer";

import { ADDS_ONLY, defineCapability } from "../types";

export const save_application_answer = defineCapability({
  id: "save_application_answer",
  kind: "write",
  permission: "writer:write",
  input: saveApplicationAnswerInput,
  output: saveApplicationAnswerOutput,
  handler: saveApplicationAnswer,
  count: () => 1,
  target: (args) => ({ type: "question", id: args.question_id }),
  annotations: ADDS_ONLY,
  text: { title: "tools.save_application_answer.title", description: "tools.save_application_answer.description" },
  availability: { available: (ctx) => ctx.writer?.inputs().writer?.enabled === true && ctx.writer.writeDb !== null, category: "disabled", message: "errors.writerDisabled" },
});
