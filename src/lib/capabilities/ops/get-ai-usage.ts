import { aiUsageOutput } from "@/lib/mcp/dto/ops";
import { getAiUsage, getAiUsageInput } from "@/lib/mcp/tools/get-ai-usage";
import { defineCapability, READ_ONLY } from "../types";

export const get_ai_usage = defineCapability({
  id: "get_ai_usage", kind: "read", permission: "ops:read",
  input: getAiUsageInput, output: aiUsageOutput, handler: getAiUsage,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.get_ai_usage.title", description: "tools.get_ai_usage.description" },
});
