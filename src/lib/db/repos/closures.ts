/** The user's own judgement whether a job is closed (`job_closure_overrides`). C9: every write of the feature lives here. */
import { eq } from "drizzle-orm";

import type { ClosureAction } from "@/lib/jobs/closure";

import type { Executor } from "../executor";
import { jobClosureOverrides, jobs } from "../schema";

export interface ClosureOverride {
  action: ClosureAction;
  note: string | null;
  createdAt: Date;
}

export async function getClosureOverride(db: Executor, jobId: number): Promise<ClosureOverride | null> {
  const [row] = await db
    .select({ action: jobClosureOverrides.action, note: jobClosureOverrides.note, createdAt: jobClosureOverrides.createdAt })
    .from(jobClosureOverrides)
    .where(eq(jobClosureOverrides.jobId, jobId))
    .limit(1);
  return row ?? null;
}

/** Set the judgement (replacing an earlier one). Returns the one it replaced, for the undo. */
export async function setClosureOverride(db: Executor, jobId: number, action: ClosureAction, note: string | null, at: Date = new Date()): Promise<ClosureOverride | null> {
  const previous = await getClosureOverride(db, jobId);
  await db
    .insert(jobClosureOverrides)
    .values({ jobId, action, note, createdAt: at })
    .onConflictDoUpdate({ target: jobClosureOverrides.jobId, set: { action, note, createdAt: at } });
  return previous;
}

/** Drop the judgement (the automatic status applies again). Returns the one it removed. */
export async function clearClosureOverride(db: Executor, jobId: number): Promise<ClosureOverride | null> {
  const previous = await getClosureOverride(db, jobId);
  if (previous) await db.delete(jobClosureOverrides).where(eq(jobClosureOverrides.jobId, jobId));
  return previous;
}

/** Undo: put back exactly what was there before (null = nothing). */
export async function restoreClosureOverride(db: Executor, jobId: number, previous: ClosureOverride | null): Promise<void> {
  if (previous === null) {
    await db.delete(jobClosureOverrides).where(eq(jobClosureOverrides.jobId, jobId));
    return;
  }
  await db
    .insert(jobClosureOverrides)
    .values({ jobId, action: previous.action, note: previous.note, createdAt: previous.createdAt })
    .onConflictDoUpdate({ target: jobClosureOverrides.jobId, set: { action: previous.action, note: previous.note, createdAt: previous.createdAt } });
}

/**
 * "Reopen": a job the user closed while the checks found nothing goes back to the automatic status (the judgement is dropped); a job
 * the checks closed or marked possibly closed gets an `open` judgement ("I checked, it is still open"), which later checks do not
 * undo. Returns the judgement it replaced, for the undo.
 */
export async function reopenJob(db: Executor, jobId: number, at: Date = new Date()): Promise<ClosureOverride | null> {
  const [job] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return null;
  if (job.status === "active") return clearClosureOverride(db, jobId);
  return setClosureOverride(db, jobId, "open", null, at);
}
