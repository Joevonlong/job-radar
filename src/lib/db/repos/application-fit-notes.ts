/** The notes on what the company background means for an application (C9: all access to `application_fit_notes` lives here). */
import { eq } from "drizzle-orm";

import type { Executor } from "../executor";
import { applicationFitNotes } from "../schema";

export type ApplicationFitNoteRow = typeof applicationFitNotes.$inferSelect;

export async function getFitNote(db: Executor, jobId: number): Promise<ApplicationFitNoteRow | null> {
  const [row] = await db.select().from(applicationFitNotes).where(eq(applicationFitNotes.jobId, jobId)).limit(1);
  return row ?? null;
}

/** A job has one note; the newest replaces it, so a request run twice leaves one. */
export async function replaceFitNote(db: Executor, note: Omit<typeof applicationFitNotes.$inferInsert, "createdAt">): Promise<void> {
  await db
    .insert(applicationFitNotes)
    .values(note)
    .onConflictDoUpdate({ target: applicationFitNotes.jobId, set: { ...note, createdAt: new Date() } });
}
