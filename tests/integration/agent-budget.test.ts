import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import {
  giveBackAgentBudget, readAgentBudget, takeAgentBudget, takeIndirectBudget,
  type BudgetDeps, type BudgetTake, type BudgetTicket,
} from "@/lib/agent-access/budget";
import type { AgentCaller } from "@/lib/agent-access/caller";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { closeDb, createConnection, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { pruneAgentBudgetUsage, readBudgetUsage, takeBudgetUnits } from "@/lib/db/repos/agent-budget";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const DAY = "2026-11-11";
const now = new Date("2026-11-11T12:00:00Z");
const resetsAt = new Date("2026-11-11T23:00:00Z");

function settings(budgets: Record<string, unknown> = {}, instant = now): BudgetDeps {
  const parsed = mcpSchema.parse({ budgets }).budgets;
  return { budgets: () => parsed, timeZone: () => "Europe/Berlin", now: () => instant };
}

function ticket(result: BudgetTake): BudgetTicket {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected a budget ticket");
  return result.ticket;
}

async function usage(caller = "stdio", action = "translate_job", day = DAY): Promise<number> {
  const [row] = await readBudgetUsage(db(), { day, keys: [{ caller, action }] });
  return row.used;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await db().execute(sql`truncate table agent_budget_usage, agent_budget_tickets`);
});
afterAll(async () => {
  await closeDb();
});

describe("agent daily budgets", () => {
  it("refuses beyond the caller cap, then allows the next local day", async () => {
    const deps = settings({ per_caller: { translate_job: 3 }, total: 20 });
    for (let i = 0; i < 3; i += 1) ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    expect(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps)).toEqual({
      ok: false, refusal: { reason: "caller_cap", action: "translate_job", cap: 3, used: 3, remaining: 0, requested: 1, resetsAt },
    });
    const nextDay = { ...deps, now: () => new Date("2026-11-11T23:30:00Z") };
    expect(ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, nextDay)).day).toBe("2026-11-12");
    expect(await usage()).toBe(3);
    expect(await usage("stdio", "translate_job", "2026-11-12")).toBe(1);
  });

  it.each([
    { per_caller: { translate_job: 0 }, total: 20 },
    { per_caller: { translate_job: 3 }, total: 0 },
  ])("does not write when either cap is zero: %j", async (budgets) => {
    expect(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, settings(budgets))).toMatchObject({
      ok: false, refusal: { reason: "not_allowed", cap: 0, used: 0, remaining: 0 },
    });
    expect(await db().select().from(schema.agentBudgetUsage)).toHaveLength(0);
  });

  it.each([0, 1.5])("rejects invalid units %s before any write", async (units) => {
    await expect(takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units }, settings())).rejects.toThrow(RangeError);
    expect(await db().select().from(schema.agentBudgetUsage)).toHaveLength(0);
  });

  it("atomically allows exactly the caller cap under concurrent takes", async () => {
    const deps = settings({ per_caller: { translate_job: 5 }, total: 20 });
    const results = await Promise.all(Array.from({ length: 10 }, () => takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps)));
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(await usage()).toBe(5);
    expect(await usage("*", "*")).toBe(5);
  });

  it("atomically enforces the total across concurrent callers and rolls back refused caller units", async () => {
    const deps = settings({ per_caller: { translate_job: 10 }, total: 4 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const caller: AgentCaller = index % 2 === 0 ? "stdio" : 7;
      return takeAgentBudget(db(), { caller, action: "translate_job" }, deps);
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(results.filter((result) => !result.ok && result.refusal.reason === "total_cap")).toHaveLength(4);
    expect(await usage("*", "*")).toBe(4);
    expect(await usage() + await usage("token:7")).toBe(4);
  });

  it("returns caller units and one total request before taking again", async () => {
    const deps = settings({ per_caller: { score_jobs: 60 }, total: 2 });
    const first = ticket(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 60 }, deps));
    expect(await giveBackAgentBudget(db(), first)).toBe(true);
    expect(await usage("stdio", "score_jobs")).toBe(0);
    expect(await usage("*", "*")).toBe(0);
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 60 }, deps));
    expect(await usage("stdio", "score_jobs")).toBe(60);
    expect(await usage("*", "*")).toBe(1);
  });

  it("gives back against the ticket day after midnight, and a second give-back of that ticket has no effect", async () => {
    const deps = settings({ per_caller: { translate_job: 3 }, total: 20 });
    const first = ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    const nextDay = { ...deps, now: () => new Date("2026-11-11T23:30:00Z") };
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, nextDay));
    expect(await giveBackAgentBudget(db(), first)).toBe(true);
    expect(await giveBackAgentBudget(db(), first)).toBe(false);
    expect(await usage()).toBe(1);
    expect(await usage("*", "*")).toBe(1);
    expect(await usage("stdio", "translate_job", "2026-11-12")).toBe(1);
    expect(await usage("*", "*", "2026-11-12")).toBe(1);
  });

  it("does not over-grant when one ticket is given back twice", async () => {
    const deps = settings({ per_caller: { translate_job: 3 }, total: 20 });
    const taken = [];
    for (let i = 0; i < 3; i += 1) taken.push(ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps)));
    await giveBackAgentBudget(db(), taken[0]);
    await giveBackAgentBudget(db(), taken[0]);
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    expect(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps)).toMatchObject({ ok: false, refusal: { reason: "caller_cap", used: 3 } });
    expect(await usage()).toBe(3);
    expect(await usage("*", "*")).toBe(3);
  });

  it("releases a ticket once under concurrent give-backs", async () => {
    const deps = settings({ per_caller: { score_jobs: 100 }, total: 20 });
    ticket(await takeAgentBudget(db(), { caller: 7, action: "score_jobs", units: 30 }, deps));
    const held = ticket(await takeAgentBudget(db(), { caller: 7, action: "score_jobs", units: 20 }, deps));
    const results = await Promise.all(Array.from({ length: 6 }, () => giveBackAgentBudget(db(), held)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await usage("token:7", "score_jobs")).toBe(30);
    expect(await usage("*", "*")).toBe(1);
  });

  it("refuses a whole batch and reports how many jobs remain without charging the total", async () => {
    const deps = settings({ per_caller: { score_jobs: 100 }, total: 5 });
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 60 }, deps));
    expect(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 50 }, deps)).toEqual({
      ok: false, refusal: { reason: "caller_cap", action: "score_jobs", cap: 100, used: 60, remaining: 40, requested: 50, resetsAt },
    });
    expect(await usage("stdio", "score_jobs")).toBe(60);
    expect(await usage("*", "*")).toBe(1);
    expect(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 101 }, deps)).toMatchObject({
      ok: false, refusal: { reason: "caller_cap", remaining: 40, requested: 101 },
    });
    expect(await usage("*", "*")).toBe(1);
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "score_jobs", units: 40 }, deps));
    expect(await usage("stdio", "score_jobs")).toBe(100);
    expect(await usage("*", "*")).toBe(2);
  });

  it("does not insert a fresh row for a batch larger than its cap", async () => {
    expect(await takeAgentBudget(db(), { caller: 7, action: "score_jobs", units: 101 }, settings({ per_caller: { score_jobs: 100 } }))).toMatchObject({
      ok: false, refusal: { reason: "caller_cap", used: 0, remaining: 100, requested: 101 },
    });
    expect(await db().select().from(schema.agentBudgetUsage)).toHaveLength(0);
  });

  it("gives each caller the full action cap", async () => {
    const deps = settings({ per_caller: { translate_job: 2 }, total: 10 });
    for (const caller of ["stdio", 7] as const) {
      for (let i = 0; i < 2; i += 1) ticket(await takeAgentBudget(db(), { caller, action: "translate_job" }, deps));
      expect(await takeAgentBudget(db(), { caller, action: "translate_job" }, deps)).toMatchObject({ ok: false, refusal: { reason: "caller_cap" } });
    }
    expect(await usage()).toBe(2);
    expect(await usage("token:7")).toBe(2);
    expect(await usage("*", "*")).toBe(4);
  });

  it("refuses both callers at the shared total without changing either caller's usage", async () => {
    const deps = settings({ per_caller: { translate_job: 10 }, total: 3 });
    for (const caller of ["stdio", 7, "stdio"] as const) ticket(await takeAgentBudget(db(), { caller, action: "translate_job" }, deps));
    for (const caller of ["stdio", 7] as const) {
      expect(await takeAgentBudget(db(), { caller, action: "translate_job" }, deps)).toEqual({
        ok: false, refusal: { reason: "total_cap", action: "translate_job", cap: 3, used: 3, remaining: 0, requested: 1, resetsAt },
      });
    }
    expect(await usage()).toBe(2);
    expect(await usage("token:7")).toBe(1);
  });

  it("rolls back a newly inserted caller row when the total refuses", async () => {
    const deps = settings({ total: 1 });
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    expect(await takeAgentBudget(db(), { caller: 7, action: "score_jobs", units: 50 }, deps)).toMatchObject({ ok: false, refusal: { reason: "total_cap" } });
    expect(await db().select().from(schema.agentBudgetUsage).where(eq(schema.agentBudgetUsage.caller, "token:7"))).toHaveLength(0);
  });

  it("reports all actions for a caller and the shared request total, including missing rows", async () => {
    const deps = settings({ per_caller: { translate_job: 3, score_jobs: 10 }, total: 8 });
    ticket(await takeAgentBudget(db(), { caller: "stdio", action: "translate_job" }, deps));
    ticket(await takeAgentBudget(db(), { caller: 7, action: "score_jobs", units: 4 }, deps));
    const read = await readAgentBudget(db(), 7, deps);
    expect(read).toMatchObject({
      day: DAY, resetsAt,
      actions: { score_jobs: { cap: 10, used: 4, remaining: 6 }, translate_job: { cap: 3, used: 0, remaining: 3 } },
      total: { cap: 8, used: 2, remaining: 6 },
    });
    expect(Object.keys(read.actions)).toHaveLength(8);
    const lowered = settings({ per_caller: { score_jobs: 2 }, total: 1 });
    expect(await readAgentBudget(db(), 7, lowered)).toMatchObject({
      actions: { score_jobs: { cap: 2, used: 4, remaining: 0 } }, total: { cap: 1, used: 2, remaining: 0 },
    });
  });

  it("lets indirect research go, skips a full caller, and contains config failures", async () => {
    const deps = settings({ per_caller: { research_company: 1 }, total: 5 });
    expect(await takeIndirectBudget(db(), { caller: "stdio", action: "research_company" }, deps)).toEqual({
      decision: "go", ticket: { id: expect.any(String), caller: "stdio", action: "research_company", day: DAY, units: 1 },
    });
    expect(await takeIndirectBudget(db(), { caller: "stdio", action: "research_company" }, deps)).toMatchObject({ decision: "skip", reason: "caller_cap", refusal: { remaining: 0 } });
    await expect(takeIndirectBudget(db(), { caller: "stdio", action: "research_company" }, {
      ...deps, budgets: () => { throw new Error("unreadable config"); },
    })).resolves.toEqual({ decision: "skip", reason: "unavailable", refusal: null });
  });

  it("guards fresh inserts in the repository and reads absent keys as zero", async () => {
    for (const units of [0, 4]) {
      expect(await takeBudgetUnits(db(), { caller: "stdio", action: "translate_job", day: DAY, units, cap: 3 })).toBeNull();
    }
    expect(await db().select().from(schema.agentBudgetUsage)).toHaveLength(0);
    expect(await readBudgetUsage(db(), { day: DAY, keys: [{ caller: "stdio", action: "translate_job" }] })).toEqual([{ caller: "stdio", action: "translate_job", used: 0 }]);
    expect(await readBudgetUsage(db(), { day: DAY, keys: [] })).toEqual([]);
  });

  it("contains database failures for indirect research", async () => {
    const connection = createConnection(url);
    await connection.sql.end({ timeout: 1 });
    await expect(takeIndirectBudget(connection.db, { caller: "stdio", action: "research_salary" }, settings())).resolves.toEqual({
      decision: "skip", reason: "unavailable", refusal: null,
    });
  });

  it("prunes only counter and ticket rows before the cutoff day", async () => {
    const days = ["2026-11-09", "2026-11-10", "2026-11-11"];
    await db().insert(schema.agentBudgetUsage).values(days.map((day) => ({ caller: "stdio", action: "translate_job", day, used: 1 })));
    await db().insert(schema.agentBudgetTickets).values(days.map((day) => ({ caller: "stdio", action: "translate_job", day, units: 1 })));
    expect(await pruneAgentBudgetUsage(db(), "2026-11-10")).toBe(2);
    const rows = await db().select().from(schema.agentBudgetUsage).orderBy(schema.agentBudgetUsage.day);
    expect(rows.map((row) => row.day)).toEqual(["2026-11-10", "2026-11-11"]);
    const held = await db().select().from(schema.agentBudgetTickets).orderBy(schema.agentBudgetTickets.day);
    expect(held.map((row) => row.day)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(await pruneAgentBudgetUsage(db(), "2026-11-10")).toBe(0);
  });
});
