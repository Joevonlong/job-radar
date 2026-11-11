import { readEffectiveConfig } from "@/lib/config";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { configProblem, readMcpSettings } from "@/lib/mcp/settings";

import { accessFromToolSwitches } from "./grants";
import { effectivePermissions, type Permission } from "./permissions";

export type AccessDecision =
  | { allowed: true; settings: McpConfig; permissions: ReadonlySet<Permission> }
  | { allowed: false; reason: "unreadable"; problem: string }
  | { allowed: false; reason: "disabled" }
  | { allowed: false; reason: "missing_permission"; permission: Permission }
  | { allowed: false; reason: "switched_off" };

/**
 * The decision for one call, made on every call: mcp.yaml is read through `readSettings`, and a read that fails refuses the call.
 * The connection's effective permissions are its grant intersected with the global matrix.
 */
export function authorize(capability: { id: string; permission: Permission }, readSettings: () => McpConfig): AccessDecision {
  let settings: McpConfig;
  try {
    settings = readSettings();
  } catch (error) {
    return { allowed: false, reason: "unreadable", problem: configProblem(error) };
  }
  const access = accessFromToolSwitches(settings);
  if (!access.enabled) return { allowed: false, reason: "disabled" };
  const permissions = effectivePermissions(access.stdio, access.matrix);
  if (!permissions.has(capability.permission)) return { allowed: false, reason: "missing_permission", permission: capability.permission };
  if (access.switchedOff(capability.id)) return { allowed: false, reason: "switched_off" };
  return { allowed: true, settings, permissions };
}

/**
 * mcp.yaml as it is on disk now. Unlike `loadConfig`, it neither uses nor updates the config cache, so a broken file throws instead
 * of yielding the last valid value; a file missing from both layers is the schema defaults (off).
 */
export function liveMcpSettings(): McpConfig {
  return readMcpSettings(() => readEffectiveConfig("mcp"));
}
