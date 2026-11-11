import { insightsOutput, insightsOutputFor } from "@/lib/mcp/dto/insights";
import { getInsights, getInsightsInput } from "@/lib/mcp/tools/get-insights";
import { defineCapability, READ_ONLY } from "../types";

export const get_insights = defineCapability({
  id: "get_insights", kind: "read", permission: "jobs:read",
  input: getInsightsInput, output: insightsOutput, handler: getInsights,
  outputFor: insightsOutputFor,
  count: () => 1, annotations: READ_ONLY,
  text: { title: "tools.get_insights.title", description: "tools.get_insights.description" },
});
