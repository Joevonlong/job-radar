import { and, desc, eq, lt, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { profileStoryDrafts } from "../schema";

export type ProfileStoryDraftRow = typeof profileStoryDrafts.$inferSelect;

/** Add the drafts of one extraction. Extracting the same text again replaces its drafts that still wait for review. */
export async function insertStoryDrafts(db: Db, input: { origin: string; sourceHash: string; drafts: readonly unknown[] }): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(profileStoryDrafts).where(and(eq(profileStoryDrafts.sourceHash, input.sourceHash), eq(profileStoryDrafts.status, "pending")));
    if (input.drafts.length === 0) return 0;
    const rows = await tx
      .insert(profileStoryDrafts)
      .values(input.drafts.map((draft) => ({ draft, origin: input.origin, sourceHash: input.sourceHash })))
      .returning({ id: profileStoryDrafts.id });
    return rows.length;
  });
}

/** The drafts waiting for review, the order the AI gave within one extraction, newest extraction first. */
export async function listPendingStoryDrafts(db: Executor): Promise<ProfileStoryDraftRow[]> {
  return db
    .select()
    .from(profileStoryDrafts)
    .where(eq(profileStoryDrafts.status, "pending"))
    .orderBy(desc(profileStoryDrafts.createdAt), profileStoryDrafts.id);
}

/** Take a waiting draft for adopting, atomically: two clicks cannot add it twice. Null: it no longer waits. */
export async function claimStoryDraft(db: Executor, id: number): Promise<ProfileStoryDraftRow | null> {
  const [row] = await db
    .update(profileStoryDrafts)
    .set({ status: "adopted" })
    .where(and(eq(profileStoryDrafts.id, id), eq(profileStoryDrafts.status, "pending")))
    .returning();
  return row ?? null;
}

/** The save of a claimed draft failed: it waits for review again. */
export async function releaseStoryDraft(db: Executor, id: number): Promise<void> {
  await db.update(profileStoryDrafts).set({ status: "pending" }).where(and(eq(profileStoryDrafts.id, id), eq(profileStoryDrafts.status, "adopted")));
}

/** The story is saved: the draft's text and quotes have no further use. */
export async function clearAdoptedStoryDraft(db: Executor, id: number): Promise<void> {
  await db.update(profileStoryDrafts).set({ draft: sql`'{}'::jsonb` }).where(and(eq(profileStoryDrafts.id, id), eq(profileStoryDrafts.status, "adopted")));
}

/** Discard a waiting draft, its text included; false when it no longer waits. */
export async function discardStoryDraft(db: Executor, id: number): Promise<boolean> {
  const rows = await db
    .update(profileStoryDrafts)
    .set({ status: "discarded", draft: sql`'{}'::jsonb` })
    .where(and(eq(profileStoryDrafts.id, id), eq(profileStoryDrafts.status, "pending")))
    .returning({ id: profileStoryDrafts.id });
  return rows.length > 0;
}

/** Delete the rows older than the limit, whatever their status; returns how many. */
export async function deleteExpiredStoryDrafts(db: Executor, ttlDays: number): Promise<number> {
  const rows = await db
    .delete(profileStoryDrafts)
    .where(lt(profileStoryDrafts.createdAt, sql`now() - make_interval(days => ${ttlDays})`))
    .returning({ id: profileStoryDrafts.id });
  return rows.length;
}
