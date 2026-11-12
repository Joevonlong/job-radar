/**
 * The agent access page's token writes: create and revoke. Each request is validated with zod, then checked against the owner session,
 * then handed to the token functions the command line uses too (same name, permission and expiry rules). Creating needs a real
 * session: tokens are only for HTTP, which needs a web password, so without one the page cannot mint a token (the command line
 * still can). Revoking needs a session once a password is set, and works whether or not MCP or HTTP is on.
 *
 * The secret of a new token leaves this module only in the return value of `createAgentTokenFromWeb`. It is never logged: failures
 * log the action name and an error code (logActionFailure), never a message, a query or the request.
 */
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { Executor } from "@/lib/db/executor";
import { revokeAgentToken } from "@/lib/db/repos/agent-tokens";
import { logActionFailure } from "@/lib/logging/action-failure";
import { ownerMayChange, type OwnerSessionState } from "@/lib/security/owner-session";

import { liveMcpSettings } from "./authorize";
import { permissionSchema, type Permission } from "./permissions";
import { checkAgentTokenRequest, createAgentToken, generateAgentToken, type AgentTokenRequestProblem } from "./tokens";

export type CreateAgentTokenFailure =
  /** A web password is set and the request has no session. */
  | "session_required"
  /** No web password: tokens are only for HTTP, which needs one. */
  | "password_required"
  | "invalid"
  | AgentTokenRequestProblem
  /** A token that is not revoked already has the name. */
  | "name_taken"
  /** A permission the global matrix does not allow. */
  | "not_in_matrix"
  /** mcp.yaml cannot be read, so the matrix is unknown. */
  | "unreadable"
  | "failed";

export interface CreatedTokenInfo {
  id: number;
  name: string;
  prefix: string;
}

export type CreateAgentTokenResult = { status: "created"; secret: string; token: CreatedTokenInfo } | { status: CreateAgentTokenFailure };

export type RevokeAgentTokenResult = { status: "revoked" } | { status: "session_required" | "invalid" | "not_found" | "failed" };

export interface TokenServiceDeps {
  db: () => Executor;
  now: () => Date;
  /** schedule.yaml `timezone`: the day an expiry date ends. */
  timezone: () => string;
  /** The global matrix of mcp.yaml as it is on disk now; throws when the file cannot be read. */
  matrix: () => readonly Permission[];
  generate: typeof generateAgentToken;
}

export const realTokenServiceDeps: TokenServiceDeps = {
  db: getDb,
  now: () => new Date(),
  timezone: () => loadConfig("schedule").timezone,
  matrix: () => liveMcpSettings().permissions,
  generate: generateAgentToken,
};

const createSchema = z.strictObject({
  name: z.string().max(500),
  permissions: z.array(permissionSchema).max(100),
  expires: z.string().max(40).nullable(),
});
const revokeSchema = z.strictObject({ id: z.number().int().positive().max(2_147_483_647) });

export async function createAgentTokenFromWeb(raw: unknown, session: OwnerSessionState, deps: TokenServiceDeps = realTokenServiceDeps): Promise<CreateAgentTokenResult> {
  const request = createSchema.safeParse(raw);
  if (!request.success) return { status: "invalid" };
  if (session === "login_required") return { status: "session_required" };
  if (session === "no_password") return { status: "password_required" };
  let matrix: ReadonlySet<Permission>;
  try {
    matrix = new Set(deps.matrix());
  } catch {
    return { status: "unreadable" };
  }
  try {
    const checked = checkAgentTokenRequest(request.data, deps.now(), deps.timezone());
    if (!checked.ok) return { status: checked.problem };
    if (checked.value.permissions.some((permission) => !matrix.has(permission))) return { status: "not_in_matrix" };
    const created = await createAgentToken(deps.db(), checked.value, deps.generate);
    if (!created.ok) return { status: created.problem };
    return { status: "created", secret: created.secret, token: { id: created.token.id, name: created.token.name, prefix: created.token.tokenPrefix } };
  } catch (error) {
    logActionFailure("createAgentToken", error);
    return { status: "failed" };
  }
}

/** Takes effect on the next HTTP request: verification and every tool call read the token row again. */
export async function revokeAgentTokenFromWeb(raw: unknown, session: OwnerSessionState, deps: Pick<TokenServiceDeps, "db" | "now"> = realTokenServiceDeps): Promise<RevokeAgentTokenResult> {
  const request = revokeSchema.safeParse(raw);
  if (!request.success) return { status: "invalid" };
  if (!ownerMayChange(session)) return { status: "session_required" };
  try {
    return { status: (await revokeAgentToken(deps.db(), request.data.id, deps.now())) ? "revoked" : "not_found" };
  } catch (error) {
    logActionFailure("revokeAgentToken", error);
    return { status: "failed" };
  }
}
