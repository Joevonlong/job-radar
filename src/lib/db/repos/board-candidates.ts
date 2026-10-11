import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { atsBoardCandidates } from "../schema";

export type BoardCandidateRow = typeof atsBoardCandidates.$inferSelect;
export type BoardCandidateStatus = "new" | "added" | "dismissed";

export interface BoardCandidateKey {
  ats: string;
  token: string;
}

export interface BoardCandidateInput extends BoardCandidateKey {
  region: string | null;
  boardUrl: string;
  title: string | null;
}

/**
 * Record boards a discovery run saw. A board seen before keeps its status (a dismissed or added
 * board does not come back as new) and only gets its last-seen time, counter and title refreshed.
 * Returns how many boards were seen for the first time.
 */
export async function upsertBoardCandidates(db: Db, items: readonly BoardCandidateInput[], at?: Date): Promise<number> {
  if (items.length === 0) return 0;
  const seenAt = at ?? sql`now()`;
  const rows = await db
    .insert(atsBoardCandidates)
    .values(items.map((i) => ({ ...i, firstSeenAt: seenAt, lastSeenAt: seenAt })))
    .onConflictDoUpdate({
      target: [atsBoardCandidates.ats, atsBoardCandidates.token],
      set: {
        lastSeenAt: seenAt,
        seenCount: sql`${atsBoardCandidates.seenCount} + 1`,
        title: sql`coalesce(excluded.title, ${atsBoardCandidates.title})`,
      },
    })
    .returning({ seenCount: atsBoardCandidates.seenCount });
  return rows.filter((r) => r.seenCount === 1).length;
}

/** Candidates in `status` (default: waiting for the user), most recently seen first. */
export async function listBoardCandidates(db: Db, status: BoardCandidateStatus = "new"): Promise<BoardCandidateRow[]> {
  return db
    .select()
    .from(atsBoardCandidates)
    .where(eq(atsBoardCandidates.status, status))
    .orderBy(desc(atsBoardCandidates.lastSeenAt), asc(atsBoardCandidates.id));
}

export async function setBoardCandidateStatus(db: Db, key: BoardCandidateKey, status: BoardCandidateStatus): Promise<boolean> {
  const rows = await db
    .update(atsBoardCandidates)
    .set({ status })
    .where(and(eq(atsBoardCandidates.ats, key.ats), eq(atsBoardCandidates.token, key.token)))
    .returning({ id: atsBoardCandidates.id });
  return rows.length > 0;
}
