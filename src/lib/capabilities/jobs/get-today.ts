import { todayOutput } from "@/lib/mcp/dto/read-jobs";
import { getToday, getTodayInput } from "@/lib/mcp/tools/get-today";
import { defineCapability, READ_ONLY } from "../types";

export const get_today = defineCapability({
  id: "get_today", kind: "read", permission: "jobs:read",
  input: getTodayInput, output: todayOutput, handler: getToday,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.get_today.title", description: "tools.get_today.description" },
});
