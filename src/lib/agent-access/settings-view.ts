/**
 * What the agent access page reads: the switches, the global matrix and the local grant of mcp.yaml as they are on disk now, with the
 * fingerprint a save is checked against; the status the doctor reports; the tools behind each permission; and the grants of the
 * connections that narrowing the matrix would affect. Server only. Nothing here throws: a part that cannot be read is reported as such.
 */
import { CAPABILITIES } from "@/lib/capabilities/registry";
import type { Capability } from "@/lib/capabilities/types";
import { layeredConfigFingerprint, loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { latestAgentCallAt } from "@/lib/db/repos/agent-calls";
import { listAgentTokens, type AgentTokenSummary } from "@/lib/db/repos/agent-tokens";
import { configProblem } from "@/lib/mcp/settings";
import { probeMcp } from "@/lib/ops/doctor/mcp-probe";
import { mcpVerdict, type McpVerdict } from "@/lib/ops/doctor/mcp-verdict";
import type { OwnerSessionState } from "@/lib/security/owner-session";
import { webPasswordUsable } from "@/lib/security/password";

import { liveMcpSettings } from "./authorize";
import { normalizePermissions } from "./matrix";
import { PERMISSIONS, isPermission, type Permission } from "./permissions";
import { agentTokenState, dayInZone, type AgentTokenState } from "./tokens";

export type AgentAccessConfig =
  | { ok: true; enabled: boolean; httpEnabled: boolean; matrix: Permission[]; stdio: Permission[]; baseHash: string }
  | { ok: false; file: string; problem: string };

export interface AgentAccessStatus {
  verdict: McpVerdict;
  /** Tokens that can still be used, read from the database whether or not mcp.yaml can be read; null when the database cannot be. */
  activeTokens: number | null;
  /** ISO time of the last recorded agent call; null before the first or when the database cannot be read. */
  lastCallAt: string | null;
}

/** A token as the page shows it: metadata only, never the hash. Times are ISO strings. */
export interface AgentTokenRow {
  id: number;
  name: string;
  prefix: string;
  permissions: Permission[];
  state: AgentTokenState;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
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
  /** Every token, oldest first; null when the database cannot be read. */
  tokens: AgentTokenRow[] | null;
  /** schedule.yaml `timezone`: the zone dates are shown in and an expiry day ends in. */
  timezone: string;
  /** Today in that zone (YYYY-MM-DD): an expiry day must come after it. */
  today: string;
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

function tokenRow(token: AgentTokenSummary, now: Date): AgentTokenRow {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    permissions: normalizePermissions(token.permissions.filter(isPermission)),
    state: agentTokenState(token, now),
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

function zone(): string {
  try {
    return loadConfig("schedule").timezone;
  } catch {
    return "UTC";
  }
}

export async function loadAgentAccessView(session: OwnerSessionState, now: Date = new Date()): Promise<AgentAccessView> {
  const config = readConfig();
  const timezone = zone();
  const [probe, lastCall, stored] = await Promise.all([
    probeMcp(now, liveMcpSettings),
    optional(() => latestAgentCallAt(getDb())),
    optional(() => listAgentTokens(getDb())),
  ]);
  const tokens = stored === null ? null : stored.map((token) => tokenRow(token, now));
  const active = tokens === null ? null : tokens.filter((token) => token.state === "active");
  return {
    session,
    passwordUsable: webPasswordUsable(),
    config,
    status: {
      verdict: mcpVerdict(probe),
      activeTokens: active === null ? null : active.length,
      lastCallAt: lastCall?.toISOString() ?? null,
    },
    tools: toolsByPermission(),
    tokenGrants: active === null ? null : active.map((token) => token.permissions),
    tokens,
    timezone,
    today: dayInZone(now, timezone),
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
