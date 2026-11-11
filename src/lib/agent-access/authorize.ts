import { readEffectiveConfig } from "@/lib/config";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { configProblem, readMcpSettings } from "@/lib/mcp/settings";

import { effectivePermissions, type Permission } from "./permissions";

export type AccessDecision =
  | { allowed: true; settings: McpConfig; permissions: ReadonlySet<Permission> }
  | { allowed: false; reason: "unreadable"; problem: string }
  | { allowed: false; reason: "disabled" }
  | { allowed: false; reason: "missing_permission"; permission: Permission };

/**
 * The decision for one call, made on every call: mcp.yaml is read through `readSettings`, and a read that fails refuses the call.
 * The connection's effective permissions are its grant intersected with the global matrix.
 */
export function authorize(capability: { id: string; permission: Permission; alsoRequires?: readonly Permission[] }, readSettings: () => McpConfig): AccessDecision {
  let settings: McpConfig;
  try {
    settings = readSettings();
  } catch (error) {
    return { allowed: false, reason: "unreadable", problem: configProblem(error) };
  }
  if (!settings.enabled) return { allowed: false, reason: "disabled" };
  const permissions = effectivePermissions(settings.stdio.permissions, settings.permissions);
  for (const permission of [capability.permission, ...capability.alsoRequires ?? []]) {
    if (!permissions.has(permission)) return { allowed: false, reason: "missing_permission", permission };
  }
  return { allowed: true, settings, permissions };
}

/**
 * mcp.yaml as it is on disk now. Unlike `loadConfig`, it neither uses nor updates the config cache, so a broken file throws instead
 * of yielding the last valid value; a file missing from both layers is the schema defaults (off).
 */
export function liveMcpSettings(): McpConfig {
  return readMcpSettings(() => readEffectiveConfig("mcp"));
}
