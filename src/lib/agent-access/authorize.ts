import { readEffectiveConfig } from "@/lib/config";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { configProblem, readMcpSettings } from "@/lib/mcp/settings";

import { effectivePermissions, type Permission } from "./permissions";

/**
 * Where a connection's granted permissions come from: the local stdio process has mcp.yaml `stdio.permissions`; a connection
 * made with an agent token has the token's own list.
 */
export type Grant = { kind: "stdio" } | { kind: "token"; tokenId: number; permissions: readonly Permission[] };

export const STDIO_GRANT: Grant = { kind: "stdio" };

/** The token's grant as it is now; null once it is revoked, expired or deleted. */
export type GrantReader = (tokenId: number) => Promise<Grant | null>;

export type AccessDecision =
  | { allowed: true; settings: McpConfig; permissions: ReadonlySet<Permission> }
  | { allowed: false; reason: "unreadable"; problem: string }
  | { allowed: false; reason: "disabled" }
  | { allowed: false; reason: "token_inactive" }
  | { allowed: false; reason: "missing_permission"; permission: Permission };

/**
 * The decision for one call, made on every call: mcp.yaml is read through `readSettings`, and a read that fails refuses the call.
 * The connection's effective permissions are its grant intersected with the global matrix.
 */
export function authorize(capability: { id: string; permission: Permission; alsoRequires?: readonly Permission[] }, readSettings: () => McpConfig, grant: Grant = STDIO_GRANT): AccessDecision {
  let settings: McpConfig;
  try {
    settings = readSettings();
  } catch (error) {
    return { allowed: false, reason: "unreadable", problem: configProblem(error) };
  }
  if (!settings.enabled) return { allowed: false, reason: "disabled" };
  const granted = grant.kind === "token" ? grant.permissions : settings.stdio.permissions;
  const permissions = effectivePermissions(granted, settings.permissions);
  for (const permission of [capability.permission, ...capability.alsoRequires ?? []]) {
    if (!permissions.has(permission)) return { allowed: false, reason: "missing_permission", permission };
  }
  return { allowed: true, settings, permissions };
}

/**
 * `authorize` for a tool call. A token connection reads its token again first, so a token revoked or expired since the
 * connection began refuses the call, and the call is judged by the token's current list. Without a reader a token connection is
 * refused. A failing read is not caught: the call fails like any other database error.
 */
export async function authorizeCall(
  capability: { id: string; permission: Permission },
  readSettings: () => McpConfig,
  grant: Grant = STDIO_GRANT,
  readGrant?: GrantReader,
): Promise<AccessDecision> {
  if (grant.kind === "stdio") return authorize(capability, readSettings, grant);
  const current = readGrant ? await readGrant(grant.tokenId) : null;
  if (current?.kind !== "token" || current.tokenId !== grant.tokenId) return { allowed: false, reason: "token_inactive" };
  return authorize(capability, readSettings, current);
}

/**
 * mcp.yaml as it is on disk now. Unlike `loadConfig`, it neither uses nor updates the config cache, so a broken file throws instead
 * of yielding the last valid value; a file missing from both layers is the schema defaults (off).
 */
export function liveMcpSettings(): McpConfig {
  return readMcpSettings(() => readEffectiveConfig("mcp"));
}
