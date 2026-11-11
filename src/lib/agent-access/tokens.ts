/**
 * Agent tokens: `jrat_` and 43 base64url characters (256 random bits). The token is shown once when it is created; the database keeps
 * its SHA-256 hash and its display prefix (`jrat_` and the next 8 characters). Verification selects the rows with the prefix and
 * compares the hash in constant time. A token never appears in a log line, an audit row or an error.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Executor } from "@/lib/db/executor";
import { findAgentTokenCredentials, getAgentTokenGrant, type AgentTokenGrantRow } from "@/lib/db/repos/agent-tokens";

import type { Grant, GrantReader } from "./authorize";
import { isPermission, type Permission } from "./permissions";

export const AGENT_TOKEN_PREFIX = "jrat_";
const SECRET_BYTES = 32;
const DISPLAY_CHARS = 8;
const TOKEN_PATTERN = /^jrat_[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

export interface GeneratedAgentToken {
  /** The token itself: printed once, never stored. */
  secret: string;
  hash: string;
  prefix: string;
}

export function isAgentTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashAgentToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function agentTokenDisplayPrefix(secret: string): string {
  return secret.slice(0, AGENT_TOKEN_PREFIX.length + DISPLAY_CHARS);
}

export function generateAgentToken(random: (size: number) => Buffer = randomBytes): GeneratedAgentToken {
  const secret = AGENT_TOKEN_PREFIX + random(SECRET_BYTES).toString("base64url");
  return { secret, hash: hashAgentToken(secret), prefix: agentTokenDisplayPrefix(secret) };
}

/** Two hex SHA-256 digests compared in constant time. */
export function sameTokenHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

/** The token of an `Authorization: Bearer <token>` header; null for any other header or a value that is not a token. */
export function bearerAgentToken(header: string | null | undefined): string | null {
  const match = header ? BEARER_PATTERN.exec(header) : null;
  const value = match?.[1];
  return value !== undefined && isAgentTokenFormat(value) ? value : null;
}

export type AgentTokenState = "active" | "revoked" | "expired";

export function agentTokenState(token: Pick<AgentTokenGrantRow, "expiresAt" | "revokedAt">, now: Date): AgentTokenState {
  if (token.revokedAt !== null) return "revoked";
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** A stored list read back: a name this version does not know grants nothing. */
export function storedPermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission);
}

export type TokenGrant = Extract<Grant, { kind: "token" }>;

function grantOf(row: AgentTokenGrantRow): TokenGrant {
  return { kind: "token", tokenId: row.id, permissions: storedPermissions(row.permissions) };
}

export type AgentTokenVerification =
  | { ok: true; grant: TokenGrant }
  | { ok: false; reason: "malformed" | "unknown" | AgentTokenState };

/** The reason is for tests and the caller's own records; a client must get the same answer for every refusal. */
export async function verifyAgentToken(db: Executor, secret: string, now: Date): Promise<AgentTokenVerification> {
  if (!isAgentTokenFormat(secret)) return { ok: false, reason: "malformed" };
  const hash = hashAgentToken(secret);
  const candidates = await findAgentTokenCredentials(db, agentTokenDisplayPrefix(secret));
  let found: AgentTokenGrantRow | undefined;
  for (const candidate of candidates) {
    if (sameTokenHash(hash, candidate.tokenHash)) found = candidate;
  }
  if (!found) return { ok: false, reason: "unknown" };
  const state = agentTokenState(found, now);
  if (state !== "active") return { ok: false, reason: state };
  return { ok: true, grant: grantOf(found) };
}

/** Reads a token's row by id on every call: its current list while it is active, otherwise null. */
export function agentTokenGrantReader(db: Executor, now: () => Date): GrantReader {
  return async (tokenId) => {
    const row = await getAgentTokenGrant(db, tokenId);
    return row && agentTokenState(row, now()) === "active" ? grantOf(row) : null;
  };
}
