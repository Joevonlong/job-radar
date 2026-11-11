import { getApplicationContextOutput } from "@/lib/mcp/dto";
import { getApplicationContext, getApplicationContextInput } from "@/lib/mcp/tools/application-context";

import { defineCapability, READ_ONLY } from "../types";

export const get_application_context = defineCapability({
  id: "get_application_context",
  kind: "read",
  permission: "writer:read",
  input: getApplicationContextInput,
  output: getApplicationContextOutput,
  handler: getApplicationContext,
  count: (output) => output.questions.length,
  target: (args) => ({ type: "job", id: args.job_id }),
  annotations: READ_ONLY,
  text: { title: "tools.get_application_context.title", description: "tools.get_application_context.description" },
  availability: { available: (ctx) => ctx.writer?.inputs().writer?.enabled === true, category: "disabled", message: "errors.writerDisabled" },
});
