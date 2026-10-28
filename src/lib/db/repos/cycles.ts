import { and, desc, eq, ne, not, sql } from "drizzle-orm";

import type { Db } from "../client";
import { cycles, runs } from "../schema";

export type Cycle = typeof cycles.$inferSelect;
export type CycleKind = Cycle["kind"];
export type CycleStatus = Cycle["status"];

/**
 * A cycle that ran for some channels only: its summary names them (`summary_json.channelIds`, written when the cycle
 * starts). Cycles without the list (every channel, and rows from before it was recorded) are full cycles.
 */
const isPartialCycle = sql<boolean>`(case when jsonb_typeof(${cycles.summaryJson} -> 'channelIds') = 'array' then jsonb_array_length(${cycles.summaryJson} -> 'channelIds') > 0 else false end)`;

/** The `channelIds` a cycle summary names; anything but a non-empty list of strings counts as "every channel" (null). */
export function readCycleChannelIds(summary: unknown): string[] | null {
  if (typeof summary !== "object" || summary === null || !("channelIds" in summary)) return null;
  const ids: unknown = summary.channelIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string")) return null;
  return ids;
}

/** `summary` is written at once, so a running cycle already tells which channels it covers (`listRunningCycles`). */
export async function createCycle(db: Db, input: { kind: CycleKind; startedAt?: Date; summary?: unknown }): Promise<Cycle> {
  const [row] = await db
    .insert(cycles)
    .values({ kind: input.kind, ...(input.startedAt ? { startedAt: input.startedAt } : {}), ...(input.summary === undefined ? {} : { summaryJson: input.summary }) })
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

/** The cycles `running` right now, newest first, with the channels each is limited to (null = every channel). */
export async function listRunningCycles(db: Db): Promise<Array<{ id: number; kind: CycleKind; channelIds: string[] | null }>> {
  const rows = await db
    .select({ id: cycles.id, kind: cycles.kind, summaryJson: cycles.summaryJson })
    .from(cycles)
    .where(eq(cycles.status, "running"))
    .orderBy(desc(cycles.startedAt), desc(cycles.id));
  return rows.map((row) => ({ id: row.id, kind: row.kind, channelIds: readCycleChannelIds(row.summaryJson) }));
}

/** Start of the newest cycle that ran for every channel (skipped cycles and cycles limited to some channels do not count), or null. */
export async function getLatestFullCycleStartedAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: cycles.startedAt })
    .from(cycles)
    .where(and(ne(cycles.status, "skipped"), not(isPartialCycle)))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(1);
  return row?.startedAt ?? null;
}

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

/** The database clock. Use it, not `new Date()`, wherever a time is compared with a stored timestamp. */
export async function getDbNow(db: Db): Promise<Date> {
  const [row] = await db.execute<{ now: Date }>(sql`select now() as now`);
  if (!row) throw new Error("getDbNow: no row returned");
  return new Date(row.now);
}

/**
 * Start of the newest cycle that ran for every channel (skipped ones and ones limited to some channels, such as a manual
 * "collect now" of one channel, do not count: they did not do the slot's work), for the runner's catch-up. When the newest one was
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
    .where(and(ne(cycles.status, "skipped"), not(isPartialCycle)))
    .orderBy(desc(cycles.startedAt), desc(cycles.id))
    .limit(2);
  if (latest === undefined) return null;
  if (!latest.interrupted || previous?.interrupted) return latest.startedAt;
  return previous?.startedAt ?? null;
}

/**
 * Mark cycles (and their runs) still `running` as failed. Only call while holding the cycle lock:
 * then nothing is running and those rows are leftovers of a crashed process. The summary written at the start (the
 * channels the cycle covered) is kept, with `orphaned` added.
 */
export async function failOrphanedCycles(db: Db, reason: string): Promise<{ cycles: number; runs: number }> {
  const failedCycles = await db
    .update(cycles)
    .set({ status: "failed", finishedAt: sql`now()`, summaryJson: sql`coalesce(${cycles.summaryJson}, '{}'::jsonb) || jsonb_build_object('orphaned', ${reason}::text)` })
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
