import { eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { jobFavorites } from "../schema";
import { wakeDormantJob } from "./dormancy";

/** A job's star as the UI needs it. */
export interface FavoriteState {
  createdAt: Date;
  note: string | null;
}

/** The stars among these jobs (jobs without one are absent from the map). */
export async function getFavoriteStates(db: Executor, jobIds: readonly number[]): Promise<Map<number, FavoriteState>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ jobId: jobFavorites.jobId, createdAt: jobFavorites.createdAt, note: jobFavorites.note })
    .from(jobFavorites)
    .where(inArray(jobFavorites.jobId, [...jobIds]));
  return new Map(rows.map((r) => [r.jobId, { createdAt: r.createdAt, note: r.note }]));
}

export async function getFavorite(db: Executor, jobId: number): Promise<FavoriteState | null> {
  const [row] = await db.select({ createdAt: jobFavorites.createdAt, note: jobFavorites.note }).from(jobFavorites).where(eq(jobFavorites.jobId, jobId)).limit(1);
  return row ?? null;
}

/**
 * Star a job. Idempotent: an existing star is left alone (`changed: false`). `restore` brings back a
 * removed star with its old note and time (undo).
 */
export async function addFavorite(db: Executor, jobId: number, restore?: { note: string | null; createdAt: Date }): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(jobFavorites)
      .values({ jobId, ...(restore ? { note: restore.note, createdAt: restore.createdAt } : {}) })
      .onConflictDoNothing()
      .returning({ jobId: jobFavorites.jobId });
    await wakeDormantJob(tx, jobId);
    return { changed: rows.length > 0 };
  });
}

/** Un-star a job; returns what the star held (for undo), null when there was none. */
export async function removeFavorite(db: Executor, jobId: number): Promise<FavoriteState | null> {
  const [row] = await db.delete(jobFavorites).where(eq(jobFavorites.jobId, jobId)).returning({ createdAt: jobFavorites.createdAt, note: jobFavorites.note });
  return row ?? null;
}

/** Set (or clear with null) the note of a star; false when the job is not starred. */
export async function setFavoriteNote(db: Executor, jobId: number, note: string | null): Promise<boolean> {
  const rows = await db.update(jobFavorites).set({ note }).where(eq(jobFavorites.jobId, jobId)).returning({ jobId: jobFavorites.jobId });
  return rows.length > 0;
}

/** Number of stars (all jobs, closed ones included). */
export async function countFavorites(db: Executor): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(jobFavorites);
  return row?.n ?? 0;
}
