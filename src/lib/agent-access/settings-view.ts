/**
 * What the agent access page reads: the switches, the global matrix and the local grant of mcp.yaml as they are on disk now, with the
 * fingerprint a save is checked against; the status the doctor reports; the tools behind each permission; and the grants of the
 * connections that narrowing the matrix would affect. Server only. Nothing here throws: a part that cannot be read is reported as such.
 */
import { CAPABILITIES } from "@/lib/capabilities/registry";
import type { Capability } from "@/lib/capabilities/types";
import { layeredConfigFingerprint } from "@/lib/config";
import { getDb } from "@/lib/db";
import { latestAgentCallAt } from "@/lib/db/repos/agent-calls";
import { activeAgentTokenGrants } from "@/lib/db/repos/agent-tokens";
import { configProblem } from "@/lib/mcp/settings";
import { probeMcp, webPasswordUsable } from "@/lib/ops/doctor/mcp-probe";
import { mcpVerdict, type McpVerdict } from "@/lib/ops/doctor/mcp-verdict";
import type { OwnerSessionState } from "@/lib/security/owner-session";

import { liveMcpSettings } from "./authorize";
import { normalizePermissions } from "./matrix";
import { PERMISSIONS, isPermission, type Permission } from "./permissions";

export type AgentAccessConfig =
  | { ok: true; enabled: boolean; httpEnabled: boolean; matrix: Permission[]; stdio: Permission[]; baseHash: string }
  | { ok: false; file: string; problem: string };

export interface AgentAccessStatus {
  verdict: McpVerdict;
  /** Tokens that can still be used; null when the database cannot be read. */
  activeTokens: number | null;
  /** ISO time of the last recorded agent call; null before the first or when the database cannot be read. */
  lastCallAt: string | null;
}

export interface AgentAccessView {
  session: OwnerSessionState;
  /** HTTP may be switched on only with a usable web password. */
  passwordUsable: boolean;
  config: AgentAccessConfig;
  status: AgentAccessStatus;
  /** The ids of the tools each permission gives. */
  tools: Record<Permission, string[]>;
  /** The own grants of the active tokens; null when the database cannot be read. */
  tokenGrants: Permission[][] | null;
}

/** Tool ids per permission, from the capability registry. */
export function toolsByPermission(capabilities: readonly Pick<Capability, "id" | "permission">[] = CAPABILITIES): Record<Permission, string[]> {
  const tools = Object.fromEntries(PERMISSIONS.map((permission) => [permission, [] as string[]])) as Record<Permission, string[]>;
  for (const capability of capabilities) tools[capability.permission].push(capability.id);
  return tools;
}

function readConfig(): AgentAccessConfig {
  try {
    const settings = liveMcpSettings();
    return {
      ok: true,
      enabled: settings.enabled,
      httpEnabled: settings.http.enabled,
      matrix: normalizePermissions(settings.permissions),
      stdio: normalizePermissions(settings.stdio.permissions),
      baseHash: layeredConfigFingerprint("mcp"),
    };
  } catch (error) {
    return { ok: false, file: "mcp.yaml", problem: configProblem(error) };
  }
}

async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function loadAgentAccessView(session: OwnerSessionState, now: Date = new Date()): Promise<AgentAccessView> {
  const config = readConfig();
  const [probe, lastCall, grants] = await Promise.all([
    probeMcp(now, liveMcpSettings),
    optional(() => latestAgentCallAt(getDb())),
    optional(() => activeAgentTokenGrants(getDb(), now)),
  ]);
  return {
    session,
    passwordUsable: webPasswordUsable(),
    config,
    status: {
      verdict: mcpVerdict(probe),
      activeTokens: probe.state === "ok" ? probe.activeTokens : null,
      lastCallAt: lastCall?.toISOString() ?? null,
    },
    tools: toolsByPermission(),
    tokenGrants: grants === null ? null : grants.map((row) => normalizePermissions(row.permissions.filter(isPermission))),
  };
}

/**
 * The address HTTP clients use, as this request reached the page: the forwarded scheme and host when a proxy set them (the host
 * check has already accepted them), otherwise the Host header.
 */
export function mcpAddress(requestHeaders: Pick<Headers, "get">): string {
  const first = (name: string) => requestHeaders.get(name)?.split(",")[0]?.trim() || null;
  const proto = first("x-forwarded-proto") === "https" ? "https" : "http";
  const host = first("x-forwarded-host") ?? first("host") ?? "localhost";
  return `${proto}://${host}/api/mcp`;
}
