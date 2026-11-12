import { activityLogOutput } from "@/lib/mcp/dto/ops";
import { getActivityLog, getActivityLogInput } from "@/lib/mcp/tools/get-activity-log";
import { defineCapability, READ_ONLY } from "../types";

export const get_activity_log = defineCapability({
  id: "get_activity_log", kind: "read", permission: "ops:read",
  input: getActivityLogInput, output: activityLogOutput, handler: getActivityLog,
  count: (output) => output.detail ? 1 : output.returned, annotations: READ_ONLY,
  text: { title: "tools.get_activity_log.title", description: "tools.get_activity_log.description" },
});
