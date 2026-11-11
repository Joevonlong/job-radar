import { and, eq, isNull, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { agentCalls, agentUndo } from "../schema";

export type AgentUndo = typeof agentUndo.$inferSelect;
export type UndoState = "undoable" | "undone" | "not_undoable";

/** Suitable for an activity query that left joins agent_undo on agent_calls.id. No private values leave this projection. */
export const agentUndoState = sql<UndoState>`case when ${agentUndo.auditId} is null then 'not_undoable' when ${agentUndo.undoneAt} is null then 'undoable' else 'undone' end`;

export async function storeAgentUndo(db: Executor, row: Omit<AgentUndo, "undoneAt">): Promise<void> {
  await db.insert(agentUndo).values({ ...row, beforeValue: sql`${JSON.stringify(row.beforeValue)}::jsonb` });
}

/** Locks the undo claim until the surrounding write transaction finishes. */
export async function getAgentUndo(db: Executor, auditId: number): Promise<AgentUndo | null> {
  const [row] = await db.select().from(agentUndo).where(eq(agentUndo.auditId, auditId)).for("update");
  return row ?? null;
}

export async function markAgentUndoDone(db: Executor, auditId: number): Promise<boolean> {
  const rows = await db.update(agentUndo).set({ undoneAt: sql`now()` })
    .where(and(eq(agentUndo.auditId, auditId), isNull(agentUndo.undoneAt))).returning({ id: agentUndo.auditId });
  return rows.length === 1;
}

export async function getAgentCallUndoState(db: Executor, auditId: number): Promise<UndoState | null> {
  const [row] = await db.select({ state: agentUndoState }).from(agentCalls)
    .leftJoin(agentUndo, eq(agentUndo.auditId, agentCalls.id)).where(eq(agentCalls.id, auditId));
  return row?.state ?? null;
}
