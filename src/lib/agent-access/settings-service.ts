/**
 * The agent access page's writes to mcp.yaml: the master and HTTP switches, the global matrix and the local stdio grant. Each request
 * is validated with zod, then checked against the owner session (a local request without a login is refused once a web password
 * is set), then written to the user's mcp.yaml through the config writer, which keeps comments and changes only the keys asked for.
 * The next agent call reads the file again, so a change applies without a restart. Nothing here throws for bad input.
 */
import { z } from "zod";

import { ConfigError, layeredConfigFingerprint, mutateConfig, writeConfig } from "@/lib/config";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { logActionFailure } from "@/lib/logging/action-failure";
import { webPasswordUsable } from "@/lib/ops/doctor/mcp-probe";
import { ownerMayChange, type OwnerSessionState } from "@/lib/security/owner-session";

import { liveMcpSettings } from "./authorize";
import { normalizePermissions } from "./matrix";
import { permissionSchema } from "./permissions";

export type AgentSettingsFailure =
  /** A web password is set and the request has no session (being on this machine is not enough). */
  | "session_required"
  | "invalid"
  /** mcp.yaml changed since the page was opened. */
  | "stale"
  /** mcp.yaml cannot be read; it is repaired in the advanced editor. */
  | "unreadable"
  /** HTTP cannot be switched on without a usable web password. */
  | "password_required"
  /** The local grant names a permission the global matrix does not allow. */
  | "not_in_matrix"
  | "failed";

export type AgentSettingsResult = { status: "saved"; baseHash: string } | { status: AgentSettingsFailure };

const switchSchema = z.strictObject({ key: z.enum(["enabled", "http"]), value: z.boolean() });
const permissionsSchema = z.strictObject({ permissions: z.array(permissionSchema).max(100), baseHash: z.string().max(200) });

function fingerprint(): string {
  try {
    return layeredConfigFingerprint("mcp");
  } catch {
    return "";
  }
}

function failureOf(where: string, error: unknown): AgentSettingsResult {
  logActionFailure(where, error);
  if (error instanceof ConfigError) {
    if (error.kind === "stale") return { status: "stale" };
    if (error.kind === "yaml" || error.kind === "schema" || error.kind === "version" || error.kind === "read" || error.kind === "missing") return { status: "unreadable" };
  }
  return { status: "failed" };
}

function current(): McpConfig | null {
  try {
    return liveMcpSettings();
  } catch {
    return null;
  }
}

/** The master switch (`enabled`) or the HTTP switch (`http.enabled`): saved at once, whatever else changed in the file meanwhile. */
export async function setAgentSwitch(raw: unknown, session: OwnerSessionState): Promise<AgentSettingsResult> {
  const request = switchSchema.safeParse(raw);
  if (!request.success) return { status: "invalid" };
  if (!ownerMayChange(session)) return { status: "session_required" };
  const { key, value } = request.data;
  if (key === "http" && value && !webPasswordUsable()) return { status: "password_required" };
  if (current() === null) return { status: "unreadable" };
  try {
    await mutateConfig("mcp", (settings) => (key === "enabled" ? { ...settings, enabled: value } : { ...settings, http: { ...settings.http, enabled: value } }));
    return { status: "saved", baseHash: fingerprint() };
  } catch (error) {
    return failureOf("setAgentSwitch", error);
  }
}

async function writePermissions(where: string, raw: unknown, session: OwnerSessionState, apply: (settings: McpConfig, chosen: McpConfig["permissions"]) => McpConfig | "not_in_matrix"): Promise<AgentSettingsResult> {
  const request = permissionsSchema.safeParse(raw);
  if (!request.success) return { status: "invalid" };
  if (!ownerMayChange(session)) return { status: "session_required" };
  const { baseHash } = request.data;
  if (baseHash !== fingerprint()) return { status: "stale" };
  const settings = current();
  if (settings === null) return { status: "unreadable" };
  const next = apply(settings, normalizePermissions(request.data.permissions));
  if (next === "not_in_matrix") return { status: "not_in_matrix" };
  try {
    await writeConfig("mcp", next, { baseHash });
    return { status: "saved", baseHash: fingerprint() };
  } catch (error) {
    return failureOf(where, error);
  }
}

/** The global matrix: the most any connection receives. */
export async function saveAgentMatrix(raw: unknown, session: OwnerSessionState): Promise<AgentSettingsResult> {
  return writePermissions("saveAgentMatrix", raw, session, (settings, chosen) => ({ ...settings, permissions: chosen }));
}

/**
 * The local stdio grant. Only permissions the matrix allows can be chosen; ones already in the file that the matrix does not allow
 * are kept as they are (they give nothing until the matrix allows them).
 */
export async function saveStdioPermissions(raw: unknown, session: OwnerSessionState): Promise<AgentSettingsResult> {
  return writePermissions("saveStdioPermissions", raw, session, (settings, chosen) => {
    const matrix = new Set(settings.permissions);
    if (chosen.some((permission) => !matrix.has(permission))) return "not_in_matrix";
    const outside = settings.stdio.permissions.filter((permission) => !matrix.has(permission));
    return { ...settings, stdio: { ...settings.stdio, permissions: normalizePermissions([...chosen, ...outside]) } };
  });
}
