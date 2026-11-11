import { and, asc, count, eq, gt, isNull, min, or } from "drizzle-orm";

import type { Executor } from "../executor";
import { agentTokens } from "../schema";

export type NewAgentToken = Pick<typeof agentTokens.$inferInsert, "name" | "tokenHash" | "tokenPrefix" | "permissions" | "expiresAt">;

/** A token as it may be shown: never its hash. */
export type AgentTokenSummary = Omit<typeof agentTokens.$inferSelect, "tokenHash">;

/** What verification needs: the stored hash and the state the token is in. */
export type AgentTokenCredential = Pick<typeof agentTokens.$inferSelect, "id" | "tokenHash" | "permissions" | "expiresAt" | "revokedAt">;

export type AgentTokenGrantRow = Pick<typeof agentTokens.$inferSelect, "id" | "permissions" | "expiresAt" | "revokedAt">;

export interface ActiveAgentTokenStats { activeTokens: number; nearestExpiry: Date | null }

/** Aggregate metadata only: active excludes revoked tokens and tokens expiring at or before now. */
export async function activeAgentTokenStats(db: Executor, now: Date): Promise<ActiveAgentTokenStats> {
  const [row] = await db.select({ activeTokens: count(), nearestExpiry: min(agentTokens.expiresAt) })
    .from(agentTokens).where(and(isNull(agentTokens.revokedAt), or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, now))));
  return row ?? { activeTokens: 0, nearestExpiry: null };
}

const summaryColumns = {
  id: agentTokens.id,
  name: agentTokens.name,
  tokenPrefix: agentTokens.tokenPrefix,
  permissions: agentTokens.permissions,
  autoApprove: agentTokens.autoApprove,
  expiresAt: agentTokens.expiresAt,
  createdAt: agentTokens.createdAt,
  lastUsedAt: agentTokens.lastUsedAt,
  revokedAt: agentTokens.revokedAt,
};

/** Null when a token that is not revoked already has the name. */
export async function insertAgentToken(db: Executor, token: NewAgentToken): Promise<AgentTokenSummary | null> {
  const [row] = await db.insert(agentTokens).values(token).onConflictDoNothing().returning(summaryColumns);
  return row ?? null;
}

export async function findAgentTokenCredentials(db: Executor, tokenPrefix: string): Promise<AgentTokenCredential[]> {
  return db
    .select({ id: agentTokens.id, tokenHash: agentTokens.tokenHash, permissions: agentTokens.permissions, expiresAt: agentTokens.expiresAt, revokedAt: agentTokens.revokedAt })
    .from(agentTokens)
    .where(eq(agentTokens.tokenPrefix, tokenPrefix));
}

export async function getAgentTokenGrant(db: Executor, id: number): Promise<AgentTokenGrantRow | null> {
  const [row] = await db
    .select({ id: agentTokens.id, permissions: agentTokens.permissions, expiresAt: agentTokens.expiresAt, revokedAt: agentTokens.revokedAt })
    .from(agentTokens)
    .where(eq(agentTokens.id, id));
  return row ?? null;
}

export async function listAgentTokens(db: Executor): Promise<AgentTokenSummary[]> {
  return db.select(summaryColumns).from(agentTokens).orderBy(asc(agentTokens.createdAt), asc(agentTokens.id));
}

/** Tokens not yet revoked whose name or display prefix is `key`. */
export async function findUnrevokedAgentTokens(db: Executor, key: string): Promise<AgentTokenSummary[]> {
  return db
    .select(summaryColumns)
    .from(agentTokens)
    .where(and(isNull(agentTokens.revokedAt), or(eq(agentTokens.name, key), eq(agentTokens.tokenPrefix, key))))
    .orderBy(asc(agentTokens.id));
}

/** False when the token does not exist or was already revoked. */
export async function revokeAgentToken(db: Executor, id: number, at: Date): Promise<boolean> {
  const rows = await db
    .update(agentTokens)
    .set({ revokedAt: at })
    .where(and(eq(agentTokens.id, id), isNull(agentTokens.revokedAt)))
    .returning({ id: agentTokens.id });
  return rows.length > 0;
}

export async function markAgentTokenUsed(db: Executor, id: number, at: Date): Promise<void> {
  await db.update(agentTokens).set({ lastUsedAt: at }).where(eq(agentTokens.id, id));
}
