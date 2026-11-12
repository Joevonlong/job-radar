/**
 * Agent tokens: `jrat_` and 43 base64url characters (256 random bits). The token is shown once when it is created; the database keeps
 * its SHA-256 hash and its display prefix (`jrat_` and the next 8 characters). Verification selects the rows with the prefix and
 * compares the hash in constant time. A token never appears in a log line, an audit row or an error.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Executor } from "@/lib/db/executor";
import {
  findAgentTokenCredentials,
  getAgentTokenGrant,
  insertAgentToken,
  type AgentTokenGrantRow,
  type AgentTokenSummary,
} from "@/lib/db/repos/agent-tokens";

import type { Grant, GrantReader } from "./authorize";
import { normalizePermissions } from "./matrix";
import { isPermission, permissionSchema, type Permission } from "./permissions";

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

// ---- Creating a token: the rules the command line and the settings page share ----

export const AGENT_TOKEN_NAME_MAX = 64;
/** Anything that could be (part of) a token. A name must not look like one, and text shown back is redacted with it. */
export const TOKEN_SHAPED_PATTERN = /jrat_[A-Za-z0-9_-]{20,}/;

export const agentTokenNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_TOKEN_NAME_MAX)
  .regex(/^[^\p{C}]+$/u)
  .refine((value) => !TOKEN_SHAPED_PATTERN.test(value));

/** An expiry day as `YYYY-MM-DD`. */
export const agentTokenDaySchema = z.iso.date();

export function redactTokens(text: string): string {
  return text.replace(new RegExp(TOKEN_SHAPED_PATTERN.source, "g"), "<redacted>");
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The first instant after `day` (YYYY-MM-DD) in `timeZone`: a token that expires on that day is valid until the day is over. */
export function endOfDayInZone(day: string, timeZone: string): Date {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  const guess = next.getTime() - zoneOffsetMs(next, timeZone);
  return new Date(next.getTime() - zoneOffsetMs(new Date(guess), timeZone));
}

/** Today in `timeZone` as `YYYY-MM-DD`. */
export function dayInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export interface AgentTokenRequest {
  name: string;
  permissions: readonly Permission[];
  /** The last day the token is valid (`YYYY-MM-DD`, in the installation's time zone); null for no expiry. */
  expires: string | null;
}

export interface CheckedAgentTokenRequest {
  name: string;
  permissions: Permission[];
  expiresAt: Date | null;
}

export type AgentTokenRequestProblem = "name_invalid" | "permissions_missing" | "expires_invalid" | "expires_past";

/** The name, the permission list and the expiry day, checked in that order; the first problem is reported. */
export function checkAgentTokenRequest(request: AgentTokenRequest, now: Date, timeZone: string): { ok: true; value: CheckedAgentTokenRequest } | { ok: false; problem: AgentTokenRequestProblem } {
  const name = agentTokenNameSchema.safeParse(request.name);
  if (!name.success) return { ok: false, problem: "name_invalid" };
  const permissions = z.array(permissionSchema).safeParse(request.permissions);
  if (!permissions.success || permissions.data.length === 0) return { ok: false, problem: "permissions_missing" };
  let expiresAt: Date | null = null;
  if (request.expires !== null) {
    const day = agentTokenDaySchema.safeParse(request.expires);
    if (!day.success) return { ok: false, problem: "expires_invalid" };
    expiresAt = endOfDayInZone(day.data, timeZone);
    if (expiresAt.getTime() <= now.getTime()) return { ok: false, problem: "expires_past" };
  }
  return { ok: true, value: { name: name.data, permissions: normalizePermissions(permissions.data), expiresAt } };
}

export type CreatedAgentToken = { ok: true; secret: string; token: AgentTokenSummary } | { ok: false; problem: "name_taken" };

/**
 * Stores a checked request: only the hash and the display prefix reach the database. The secret is returned to the one caller that
 * shows it; it must not be logged, stored or put in an error.
 */
export async function createAgentToken(db: Executor, request: CheckedAgentTokenRequest, generate: typeof generateAgentToken = generateAgentToken): Promise<CreatedAgentToken> {
  const token = generate();
  const row = await insertAgentToken(db, { name: request.name, tokenHash: token.hash, tokenPrefix: token.prefix, permissions: request.permissions, expiresAt: request.expiresAt });
  if (!row) return { ok: false, problem: "name_taken" };
  return { ok: true, secret: token.secret, token: row };
}
