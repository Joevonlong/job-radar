import { and, eq, lt, or, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { agentBudgetTickets as tickets, agentBudgetUsage as usage } from "../schema";

type BudgetKey = { caller: string; action: string };
type HeldTicket = BudgetKey & { day: string; units: number };

export async function takeBudgetUnits(db: Executor, input: BudgetKey & { day: string; units: number; cap: number }): Promise<number | null> {
  if (input.units < 1 || input.units > input.cap) return null;
  const [row] = await db.insert(usage)
    .values({ caller: input.caller, action: input.action, day: input.day, used: input.units })
    .onConflictDoUpdate({
      target: [usage.caller, usage.action, usage.day],
      set: { used: sql`${usage.used} + excluded.used`, updatedAt: sql`now()` },
      setWhere: sql`${usage.used} + excluded.used <= ${input.cap}`,
    })
    .returning({ used: usage.used });
  return row?.used ?? null;
}

export async function giveBackBudgetUnits(db: Executor, input: BudgetKey & { day: string; units: number }): Promise<void> {
  await db.update(usage)
    .set({ used: sql`greatest(${usage.used} - ${input.units}, 0)`, updatedAt: sql`now()` })
    .where(and(eq(usage.caller, input.caller), eq(usage.action, input.action), eq(usage.day, input.day)));
}

export async function recordBudgetTicket(db: Executor, input: HeldTicket): Promise<string> {
  const [row] = await db.insert(tickets).values(input).returning({ id: tickets.id });
  return row.id;
}

/** Deletes the ticket and returns what it held; a ticket already given back or pruned returns null. */
export async function claimBudgetTicket(db: Executor, id: string): Promise<HeldTicket | null> {
  const [row] = await db.delete(tickets).where(eq(tickets.id, id))
    .returning({ caller: tickets.caller, action: tickets.action, day: tickets.day, units: tickets.units });
  return row ?? null;
}

/** Returns one entry per requested key, including zero for a missing row. */
export async function readBudgetUsage(db: Executor, input: { day: string; keys: BudgetKey[] }): Promise<(BudgetKey & { used: number })[]> {
  if (input.keys.length === 0) return [];
  const rows = await db.select({ caller: usage.caller, action: usage.action, used: usage.used }).from(usage)
    .where(and(eq(usage.day, input.day), or(...input.keys.map((key) => and(eq(usage.caller, key.caller), eq(usage.action, key.action))))));
  return input.keys.map((key) => ({ ...key, used: rows.find((row) => row.caller === key.caller && row.action === key.action)?.used ?? 0 }));
}

export async function pruneAgentBudgetRows(db: Executor, beforeDay: string): Promise<number> {
  const counters = await db.delete(usage).where(lt(usage.day, beforeDay));
  const held = await db.delete(tickets).where(lt(tickets.day, beforeDay));
  return counters.count + held.count;
}
