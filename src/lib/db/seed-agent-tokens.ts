import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Executor } from "./executor";
import { agentTokens } from "./schema";

/**
 * Two fictional agent tokens for the development, e2e and preview databases: one active, one revoked, so the agent access page has
 * rows to show. Neither can be used: the stored hash belongs to no token (it is the digest of a label, not of a `jrat_` secret), and
 * the display prefix says it is an example. Run again, they are put back as they were (matched by hash).
 *
 * Kept out of `seedDatabase`: integration tests seed that and count the token table from empty.
 */
export const SEED_AGENT_TOKENS = [
  { label: "laptop", name: "Example laptop", tokenPrefix: "jrat_example1", permissions: ["jobs:read", "tracking:read", "notes:read", "notes:write"], revoked: false, createdDaysAgo: 12, usedHoursAgo: 3 },
  { label: "tablet", name: "Old tablet", tokenPrefix: "jrat_example2", permissions: ["jobs:read"], revoked: true, createdDaysAgo: 40, usedHoursAgo: 24 * 21 },
] as const;

export function seedAgentTokenHash(label: string): string {
  return createHash("sha256").update(`job-radar seed agent token: ${label}`, "utf8").digest("hex");
}

export async function seedAgentTokens(db: Executor, now: Date = new Date()): Promise<number> {
  const hours = (n: number) => new Date(now.getTime() - n * 3_600_000);
  const rows = SEED_AGENT_TOKENS.map((token) => ({
    name: token.name,
    tokenHash: seedAgentTokenHash(token.label),
    tokenPrefix: token.tokenPrefix,
    permissions: [...token.permissions],
    expiresAt: null,
    createdAt: hours(token.createdDaysAgo * 24),
    lastUsedAt: hours(token.usedHoursAgo),
    revokedAt: token.revoked ? hours(24 * 20) : null,
  }));
  await db
    .insert(agentTokens)
    .values(rows)
    .onConflictDoUpdate({
      target: agentTokens.tokenHash,
      set: {
        name: sql`excluded.name`,
        tokenPrefix: sql`excluded.token_prefix`,
        permissions: sql`excluded.permissions`,
        expiresAt: sql`excluded.expires_at`,
        createdAt: sql`excluded.created_at`,
        lastUsedAt: sql`excluded.last_used_at`,
        revokedAt: sql`excluded.revoked_at`,
      },
    });
  return rows.length;
}
