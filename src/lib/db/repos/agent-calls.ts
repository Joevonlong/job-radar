import { lt, max } from "drizzle-orm";

import { createConnection, databaseUrlFor, type Db } from "../client";
import type { Executor } from "../executor";
import { agentCalls } from "../schema";

export type AgentCallRow = Omit<typeof agentCalls.$inferSelect, "id" | "calledAt">;

export function openAgentCallsConnection(source: string | Db, options: { connectTimeoutSeconds: number; statementTimeoutMs: number; lockTimeoutMs: number }) {
  return createConnection(typeof source === "string" ? source : databaseUrlFor(source), {
    max: 1,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
    sessionSettings: {
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      idle_in_transaction_session_timeout: options.statementTimeoutMs,
    },
  });
}

export async function insertAgentCall(db: Executor, row: AgentCallRow): Promise<void> {
  await db.insert(agentCalls).values(row);
}

export async function pruneAgentCalls(db: Executor, olderThan: Date): Promise<number> {
  const rows = await db.delete(agentCalls).where(lt(agentCalls.calledAt, olderThan)).returning({ id: agentCalls.id });
  return rows.length;
}

/** When any agent last made a call that was recorded; null before the first one. */
export async function latestAgentCallAt(db: Executor): Promise<Date | null> {
  const [row] = await db.select({ at: max(agentCalls.calledAt) }).from(agentCalls);
  return row?.at ?? null;
}
