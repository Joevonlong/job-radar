/**
 * What `data.mcp` and the agent access page's status card both report: the switches of mcp.yaml, the matrix and the effective local
 * grant, whether HTTP has its web-password precondition, and aggregate token metadata. One probe and one verdict, so the page and
 * the doctor never disagree.
 */
import { effectivePermissions } from "@/lib/agent-access/permissions";
import { ConfigError, firstConfigProblem } from "@/lib/config/errors";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { getDb } from "@/lib/db";
import { activeAgentTokenStats } from "@/lib/db/repos/agent-tokens";
import { readMcpSettings } from "@/lib/mcp/settings";
import { readPasswordSetting } from "@/lib/security/password";

import type { McpProbe } from "./types";

type Env = Readonly<Record<string, string | undefined>>;

/** A password HTTP may rely on: set, and when given as a hash, a hash this code can read. */
export function webPasswordUsable(env: Env = process.env): boolean {
  const password = readPasswordSetting(env);
  return password !== null && (password.kind !== "hash" || password.parsed !== null);
}

/** Never throws; token counts are aggregate metadata and a database failure leaves them unknown. */
export async function probeMcp(now: Date, read: () => McpConfig = () => readMcpSettings()): Promise<McpProbe> {
  try {
    const settings = read();
    let stats: { activeTokens: number | null; nearestExpiry: Date | null } = { activeTokens: null, nearestExpiry: null };
    try { stats = await activeAgentTokenStats(getDb(), now); } catch {}
    return {
      state: "ok", enabled: settings.enabled, permissions: settings.permissions,
      effective: [...effectivePermissions(settings.stdio.permissions, settings.permissions)], auditRetentionDays: settings.audit.retention_days,
      httpEnabled: settings.http.enabled, webPasswordUsable: webPasswordUsable(),
      ...stats,
    };
  } catch (error) {
    return { state: "config_error", problem: error instanceof ConfigError ? firstConfigProblem(error) : "unreadable" };
  }
}
