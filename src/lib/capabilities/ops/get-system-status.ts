import { systemStatusOutput } from "@/lib/mcp/dto/ops";
import { getSystemStatus, getSystemStatusInput } from "@/lib/mcp/tools/get-system-status";
import { defineCapability, READ_ONLY } from "../types";

export const get_system_status = defineCapability({
  id: "get_system_status", kind: "read", permission: "ops:read",
  input: getSystemStatusInput, output: systemStatusOutput, handler: getSystemStatus,
  count: () => 1, annotations: READ_ONLY,
  text: { title: "tools.get_system_status.title", description: "tools.get_system_status.description" },
});
