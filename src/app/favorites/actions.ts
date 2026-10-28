"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { FAVORITE_NOTE_MAX_CHARS } from "@/lib/dashboard/limits";
import { addFavorite, getDb, jobExists, removeFavorite, setFavoriteNote } from "@/lib/db";

/**
 * Server Actions for the star on a job. They set a value rather than flip one, so a double click or two tabs end in the
 * state the user saw last. The web app is single-user and bound to loopback (C5); input is still validated (C6).
 */

const jobIdSchema = z.number().int().positive();
const setSchema = z.object({ jobId: jobIdSchema, favorite: z.boolean() });
const restoreSchema = z.object({ jobId: jobIdSchema, note: z.string().max(FAVORITE_NOTE_MAX_CHARS).nullable(), createdAt: z.iso.datetime() });
const noteSchema = z.object({ jobId: jobIdSchema, note: z.string().max(FAVORITE_NOTE_MAX_CHARS) });

/** What an un-star held, so the toast's undo can bring it back as it was. */
export interface RemovedFavorite {
  note: string | null;
  createdAt: string;
}

export type SetFavoriteResult =
  | { ok: true; favorite: boolean; changed: boolean; removed: RemovedFavorite | null }
  | { ok: false; error: "invalid" | "not_found" | "failed" };

export type RestoreFavoriteResult = { ok: true } | { ok: false; error: "invalid" | "not_found" | "failed" };
export type FavoriteNoteResult = { ok: true; note: string | null } | { ok: false; error: "invalid" | "not_found" | "not_favorite" | "failed" };

/** The star shows in the sidebar count, the lists and the board: everything re-reads. */
function refreshViews(): void {
  revalidatePath("/", "layout");
}

export async function setFavoriteAction(input: { jobId: number; favorite: boolean }): Promise<SetFavoriteResult> {
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    if (parsed.data.favorite) {
      const { changed } = await addFavorite(db, parsed.data.jobId);
      refreshViews();
      return { ok: true, favorite: true, changed, removed: null };
    }
    const removed = await removeFavorite(db, parsed.data.jobId);
    refreshViews();
    return { ok: true, favorite: false, changed: removed !== null, removed: removed ? { note: removed.note, createdAt: removed.createdAt.toISOString() } : null };
  } catch (error) {
    logActionFailure("setFavoriteAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Undo of an un-star: the star comes back with its old note and time. */
export async function restoreFavoriteAction(input: { jobId: number; note: string | null; createdAt: string }): Promise<RestoreFavoriteResult> {
  const parsed = restoreSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    await addFavorite(db, parsed.data.jobId, { note: parsed.data.note, createdAt: new Date(parsed.data.createdAt) });
    refreshViews();
    return { ok: true };
  } catch (error) {
    logActionFailure("restoreFavoriteAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Save the note of a star (blank clears it). */
export async function saveFavoriteNoteAction(input: { jobId: number; note: string }): Promise<FavoriteNoteResult> {
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const note = parsed.data.note.trim() === "" ? null : parsed.data.note.trim();
    if (!(await setFavoriteNote(db, parsed.data.jobId, note))) return { ok: false, error: "not_favorite" };
    revalidatePath("/favorites");
    return { ok: true, note };
  } catch (error) {
    logActionFailure("saveFavoriteNoteAction", error);
    return { ok: false, error: "failed" };
  }
}
