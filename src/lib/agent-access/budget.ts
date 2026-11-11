import { loadConfig } from "@/lib/config";
import { AGENT_ACTIONS, type AgentAction, type McpBudgets } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { giveBackBudgetUnits, readBudgetUsage, takeBudgetUnits } from "@/lib/db/repos/agent-budget";
import { addDays, dayInZone, startOfDayInZone } from "@/lib/insights/range";

import { liveMcpSettings } from "./authorize";
import { callerKey, type AgentCaller } from "./caller";

export type BudgetRefusal = {
  reason: "not_allowed" | "caller_cap" | "total_cap";
  action: AgentAction;
  cap: number;
  used: number;
  remaining: number;
  requested: number;
  resetsAt: Date;
};
export type BudgetTicket = { caller: AgentCaller; action: AgentAction; day: string; units: number };
export type BudgetTake = { ok: true; ticket: BudgetTicket } | { ok: false; refusal: BudgetRefusal };
export interface BudgetDeps {
  budgets(): McpBudgets;
  timeZone(): string;
  now(): Date;
}

const defaultDeps: BudgetDeps = {
  budgets: () => liveMcpSettings().budgets,
  timeZone: () => loadConfig("schedule").timezone,
  now: () => new Date(),
};

export function agentBudgetWindow(now: Date, timeZone: string): { day: string; resetsAt: Date } {
  const day = dayInZone(now, timeZone);
  return { day, resetsAt: startOfDayInZone(addDays(day, 1), timeZone) };
}

function budgetUnits(units = 1): number {
  if (!Number.isInteger(units) || units < 1) throw new RangeError("budget units must be a positive integer");
  return units;
}

function refusal(reason: BudgetRefusal["reason"], action: AgentAction, cap: number, used: number, requested: number, resetsAt: Date): BudgetRefusal {
  return { reason, action, cap, used, remaining: Math.max(cap - used, 0), requested, resetsAt };
}

export function checkAgentBudget(input: {
  action: AgentAction; units?: number; cap: number; totalCap: number; used: number; totalUsed: number; resetsAt: Date;
}): BudgetRefusal | null {
  const units = budgetUnits(input.units);
  if (input.cap === 0) return refusal("not_allowed", input.action, input.cap, input.used, units, input.resetsAt);
  if (input.totalCap === 0) return refusal("not_allowed", input.action, input.totalCap, input.totalUsed, units, input.resetsAt);
  if (units > input.cap) return refusal("caller_cap", input.action, input.cap, input.used, units, input.resetsAt);
  return null;
}

class TotalBudgetRefused extends Error {
  constructor(readonly refusal: BudgetRefusal) {
    super("total agent budget refused");
  }
}

/** Reserves caller units and one total request atomically, always locking the caller row before the total row. */
export async function takeAgentBudget(db: Db, input: { caller: AgentCaller; action: AgentAction; units?: number }, deps: BudgetDeps = defaultDeps): Promise<BudgetTake> {
  const units = budgetUnits(input.units);
  const budgets = deps.budgets();
  const { day, resetsAt } = agentBudgetWindow(deps.now(), deps.timeZone());
  const caller = callerKey(input.caller);
  const cap = budgets.per_caller[input.action];
  const callerRow = { caller, action: input.action, day };
  const totalRow = { caller: "*", action: "*", day };
  if (cap === 0 || budgets.total === 0 || units > cap) {
    const [own, total] = await readBudgetUsage(db, { day, keys: [callerRow, totalRow] });
    const rejected = checkAgentBudget({ action: input.action, units, cap, totalCap: budgets.total, used: own.used, totalUsed: total.used, resetsAt });
    if (rejected) return { ok: false, refusal: rejected };
  }
  try {
    return await db.transaction(async (tx): Promise<BudgetTake> => {
      const used = await takeBudgetUnits(tx, { ...callerRow, units, cap });
      if (used === null) {
        const [own] = await readBudgetUsage(tx, { day, keys: [callerRow] });
        return { ok: false, refusal: refusal("caller_cap", input.action, cap, own.used, units, resetsAt) };
      }
      const totalUsed = await takeBudgetUnits(tx, { ...totalRow, units: 1, cap: budgets.total });
      if (totalUsed === null) {
        const [total] = await readBudgetUsage(tx, { day, keys: [totalRow] });
        throw new TotalBudgetRefused(refusal("total_cap", input.action, budgets.total, total.used, units, resetsAt));
      }
      return { ok: true, ticket: { caller: input.caller, action: input.action, day, units } };
    });
  } catch (error) {
    if (error instanceof TotalBudgetRefused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

/** Releases a merged or cached request against the day named by its ticket, even after local midnight. */
export async function giveBackAgentBudget(db: Db, ticket: BudgetTicket): Promise<void> {
  await db.transaction(async (tx) => {
    await giveBackBudgetUnits(tx, { caller: callerKey(ticket.caller), action: ticket.action, day: ticket.day, units: ticket.units });
    await giveBackBudgetUnits(tx, { caller: "*", action: "*", day: ticket.day, units: 1 });
  });
}

type BudgetUsage = { cap: number; used: number; remaining: number };

export async function readAgentBudget(db: Db, caller: AgentCaller, deps: BudgetDeps = defaultDeps): Promise<{
  day: string; resetsAt: Date; actions: Record<AgentAction, BudgetUsage>; total: BudgetUsage;
}> {
  const budgets = deps.budgets();
  const window = agentBudgetWindow(deps.now(), deps.timeZone());
  const keys = [...AGENT_ACTIONS.map((action) => ({ caller: callerKey(caller), action })), { caller: "*", action: "*" }];
  const rows = await readBudgetUsage(db, { day: window.day, keys });
  const actions = {} as Record<AgentAction, BudgetUsage>;
  for (const action of AGENT_ACTIONS) {
    const used = rows.find((row) => row.action === action)?.used ?? 0;
    const cap = budgets.per_caller[action];
    actions[action] = { cap, used, remaining: Math.max(cap - used, 0) };
  }
  const used = rows.find((row) => row.action === "*")?.used ?? 0;
  return { ...window, actions, total: { cap: budgets.total, used, remaining: Math.max(budgets.total - used, 0) } };
}

export type IndirectBudgetDecision =
  | { decision: "go"; ticket: BudgetTicket }
  | { decision: "skip"; reason: BudgetRefusal["reason"] | "unavailable"; refusal: BudgetRefusal | null };

/** The caller does its write either way; on "skip" it does not queue research and says why in its answer. */
export async function takeIndirectBudget(db: Db, input: { caller: AgentCaller; action: AgentAction }, deps: BudgetDeps = defaultDeps): Promise<IndirectBudgetDecision> {
  try {
    const result = await takeAgentBudget(db, { ...input, units: 1 }, deps);
    return result.ok ? { decision: "go", ticket: result.ticket } : { decision: "skip", reason: result.refusal.reason, refusal: result.refusal };
  } catch {
    return { decision: "skip", reason: "unavailable", refusal: null };
  }
}
