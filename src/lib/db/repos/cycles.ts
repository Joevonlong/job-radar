import { desc, eq, ne, sql } from "drizzle-orm";

import type { Db } from "../client";
import { cycles, runs } from "../schema";

export type Cycle = typeof cycles.$inferSelect;
export type CycleKind = Cycle["kind"];
export type CycleStatus = Cycle["status"];

export async function createCycle(db: Db, input: { kind: CycleKind; startedAt?: Date }): Promise<Cycle> {
  const [row] = await db
    .insert(cycles)
    .values({ kind: input.kind, ...(input.startedAt ? { startedAt: input.startedAt } : {}) })
    .returning();
  if (!row) throw new Error("createCycle: insert returned no row");
  return row;
}

export async function finishCycle(
  db: Db,
  id: number,
  input: { status: Exclude<CycleStatus, "running">; summary?: unknown },
): Promise<Cycle | null> {
  const [row] = await db
    .update(cycles)
    .set({ status: input.status, finishedAt: sql`now()`, summaryJson: input.summary ?? null })
    .where(eq(cycles.id, id))
    .returning();
  return row ?? null;
}

export async function getCycle(db: Db, id: number): Promise<Cycle | null> {
  const [row] = await db.select().from(cycles).where(eq(cycles.id, id)).limit(1);
  return row ?? null;
}

export async function getLatestCycle(db: Db): Promise<Cycle | null> {
  const [row] = await db.select().from(cycles).orderBy(desc(cycles.startedAt), desc(cycles.id)).limit(1);
  return row ?? null;
}

/** Record a cycle that did not run (another one held the lock): one finished row with status `skipped`. */
export async function createSkippedCycle(db: Db, input: { kind: CycleKind; summary?: unknown }): Promise<Cycle> {
  const [row] = await db
    .insert(cycles)
    .values({ kind: input.kind, status: "skipped", finishedAt: sql`now()`, summaryJson: input.summary ?? null })
    .returning();
  if (!row) throw new Error("createSkippedCycle: insert returned no row");
  return row;
}

/** Start time of the most recent cycle that actually ran (skipped cycles do not count), or null. */
/** The database clock. Use it, not `new Date()`, wherever a time is compared with a stored timestamp. */
/** Whether a cycle is running right now (a channel test waits for the next quiet moment). */
export async function isCycleRunning(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: cycles.id }).from(cycles).where(eq(cycles.status, "running")).limit(1);
  return row !== undefined;
}

/** How many cycles are `running` right now (what a deploy waits for). */
export async function countRunningCycles(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(cycles).where(eq(cycles.status, "running"));
  return row?.n ?? 0;
}

export async function getDbNow(db: Db): Promise<Date> {
  const [row] = await db.execute<{ now: Date }>(sql`select now() as now`);
  if (!row) throw new Error("getDbNow: no row returned");
  return new Date(row.now);
}

/**
 * Start of the newest cycle that ran (skipped ones do not count), for the runner's catch-up. When the newest one was
 * interrupted (a shutdown cut it off, `summary_json.aborted`, or a dead runner left it behind, `summary_json.orphaned`), the
 * cycle before it is the reference instead, so a deploy that restarted the runner mid-cycle gets that slot run again at
 * start-up. Only once: when the cycle before was interrupted too (the re-run died as well, say a cycle that crashes the
 * runner), the newest counts, so a crash cannot turn into a loop of full collections.
 */
export async function getLatestRunStartedAt(db: Db): Promise<Date | null> {
  const interrupted = sql<boolean>`coalesce(${cycles.status} = 'failed' and (${cycles.summaryJson} ->> 'aborted' = 'true' or (${cycles.summaryJson} -> 'orphaned') is not null), false)`;
  const [latest, previous] = await db
    .select({ startedAt: cycles.startedAt, interrupted })
    .from(cycles)
    .where(ne(cycles.status, "skipped"))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(2);
  if (latest === undefined) return null;
  if (!latest.interrupted || previous?.interrupted) return latest.startedAt;
  return previous?.startedAt ?? null;
}

/**
 * Mark cycles (and their runs) still `running` as failed. Only call while holding the cycle lock:
 * then nothing is running and those rows are leftovers of a crashed process.
 */
export async function failOrphanedCycles(db: Db, reason: string): Promise<{ cycles: number; runs: number }> {
  const failedCycles = await db
    .update(cycles)
    .set({ status: "failed", finishedAt: sql`now()`, summaryJson: sql`jsonb_build_object('orphaned', ${reason}::text)` })
    .where(eq(cycles.status, "running"))
    .returning({ id: cycles.id });
  const failedRuns = await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, error: reason, errorCode: "unknown" })
    .where(eq(runs.status, "running"))
    .returning({ id: runs.id });
  return { cycles: failedCycles.length, runs: failedRuns.length };
}

/** One step of a cycle summary as the ai-worker reports it (same shape as `StepSummary` in the cycle runner). */
export interface DelegatedStepSummary {
  name: string;
  status: "ok" | "partial" | "failed" | "skipped";
  durationMs: number;
  result?: unknown;
  error?: string;
  reason?: string;
}

/**
 * The ai-worker's outcome for the steps a cycle delegated (`ai`, `notify`): each replaces the `delegated`
 * placeholder of the same name in `summary_json.steps`, and a `succeeded` cycle becomes `partial` when one of
 * them did not fully succeed. Returns the cycle's status afterwards, or null when the cycle is gone.
 */
export async function applyDelegatedSteps(db: Db, cycleId: number, steps: readonly DelegatedStepSummary[]): Promise<CycleStatus | null> {
  const cycle = await getCycle(db, cycleId);
  if (!cycle) return null;
  const summary = typeof cycle.summaryJson === "object" && cycle.summaryJson !== null && !Array.isArray(cycle.summaryJson) ? { ...(cycle.summaryJson as Record<string, unknown>) } : {};
  const existing = Array.isArray(summary.steps) ? (summary.steps as unknown[]) : [];
  const names = new Set(steps.map((s) => s.name));
  const replaced = existing.map((entry) => {
    const name = typeof entry === "object" && entry !== null && "name" in entry ? (entry as { name: unknown }).name : undefined;
    return typeof name === "string" && names.has(name) ? steps.find((s) => s.name === name) : entry;
  });
  const present = new Set(existing.map((entry) => (typeof entry === "object" && entry !== null && "name" in entry ? (entry as { name: unknown }).name : undefined)));
  const merged = [...replaced, ...steps.filter((s) => !present.has(s.name))];
  const degraded = steps.some((s) => s.status === "failed" || s.status === "partial");
  const status: CycleStatus = cycle.status === "succeeded" && degraded ? "partial" : cycle.status;
  await db
    .update(cycles)
    .set({ status, summaryJson: { ...summary, steps: merged } })
    .where(eq(cycles.id, cycleId));
  return status;
}
