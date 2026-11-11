/** mcp.yaml has per-tool switches today; this function is the only place that turns them into permissions. */
import { MCP_TOOL_NAMES, type McpConfig } from "@/lib/config/schemas/mcp";

import type { Permission } from "./permissions";

export interface AccessSettings {
  enabled: boolean;
  matrix: ReadonlySet<Permission>;
  stdio: ReadonlySet<Permission>;
  switchedOff: (capabilityId: string) => boolean;
}

export function accessFromToolSwitches(settings: McpConfig): AccessSettings {
  const permissions = new Set<Permission>();
  const tools = settings.tools;
  if (tools.search_jobs === true || tools.get_job === true) permissions.add("jobs:read");
  if (tools.list_applications === true) permissions.add("tracking:read");
  if (tools.get_application_context === true) permissions.add("writer:read");
  if (tools.save_application_answer === true) permissions.add("writer:write");
  return {
    enabled: settings.enabled,
    matrix: permissions,
    stdio: permissions,
    switchedOff: (id) => MCP_TOOL_NAMES.some((name) => name === id && tools[name] !== true),
  };
}
