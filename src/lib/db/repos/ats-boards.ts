import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { atsBoards, rawPostings } from "../schema";

export type AtsBoardRow = typeof atsBoards.$inferSelect;
export type AtsBoardStatus = "ok" | "not_modified" | "error";

export interface AtsBoardKey {
  ats: string;
  token: string;
}

export async function getAtsBoard(db: Db, key: AtsBoardKey): Promise<AtsBoardRow | null> {
  const [row] = await db
    .select()
    .from(atsBoards)
    .where(and(eq(atsBoards.ats, key.ats), eq(atsBoards.token, key.token)))
    .limit(1);
  return row ?? null;
}

export interface AtsBoardUpdate {
  status: AtsBoardStatus;
  /** Only meaningful for `ok`; for `not_modified` and `error` the stored validator is left alone. */
  etag?: string | null;
  filterFingerprint?: string;
  externalIds?: readonly string[];
  total?: number;
  kept?: number;
  errorCode?: string | null;
  checkedAt?: Date;
}

/**
 * Record the outcome of one board check. `ok` replaces the validator, fingerprint, ids and counts
 * (a response without a usable ETag clears the old one); `not_modified` and `error` only stamp the
 * check, so a failing or unchanged board keeps its last known state (C2).
 */
export async function recordAtsBoardCheck(db: Db, key: AtsBoardKey, update: AtsBoardUpdate): Promise<void> {
  const checkedAt = update.checkedAt ?? sql`now()`;
  if (update.status === "ok") {
    const values = {
      etag: update.etag ?? null,
      filterFingerprint: update.filterFingerprint ?? null,
      externalIds: [...(update.externalIds ?? [])],
      lastStatus: "ok",
      lastErrorCode: null,
      lastCheckedAt: checkedAt,
      lastChangedAt: checkedAt,
      lastTotal: update.total ?? 0,
      lastKept: update.kept ?? 0,
      consecutiveFailures: 0,
      lastOkAt: checkedAt,
    };
    await db
      .insert(atsBoards)
      .values({ ...key, ...values })
      .onConflictDoUpdate({ target: [atsBoards.ats, atsBoards.token], set: values });
    return;
  }
  const stamp = {
    lastStatus: update.status,
    lastErrorCode: update.status === "error" ? (update.errorCode ?? "unknown") : null,
    lastCheckedAt: checkedAt,
  };
  // A 304 counts as healthy (fails reset, last_ok_at moves); an error adds one to the streak
  const failed = update.status === "error";
  await db
    .insert(atsBoards)
    .values({ ...key, ...stamp, consecutiveFailures: failed ? 1 : 0, lastOkAt: failed ? null : checkedAt })
    .onConflictDoUpdate({
      target: [atsBoards.ats, atsBoards.token],
      set: failed
        ? { ...stamp, consecutiveFailures: sql`${atsBoards.consecutiveFailures} + 1` }
        : { ...stamp, consecutiveFailures: 0, lastOkAt: checkedAt },
    });
}

/**
 * A board still lists these postings (on a 200 or 304). Refresh `fetched_at` of the raw postings of
 * `channelId` with these external ids, so the lifecycle (last seen) does not age them out. Returns
 * the external ids that exist and were refreshed; ids that were never stored are excluded.
 */
export async function touchRawPostings(
  db: Db,
  input: { channelId: string; externalIds: readonly string[]; at?: Date },
): Promise<string[]> {
  if (input.externalIds.length === 0) return [];
  const at = input.at ?? sql`now()`;
  const present: string[] = [];
  const ids = [...input.externalIds];
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db
      .update(rawPostings)
      .set({ fetchedAt: at })
      .where(and(eq(rawPostings.channelId, input.channelId), inArray(rawPostings.externalId, ids.slice(i, i + 1000))))
      .returning({ externalId: rawPostings.externalId });
    present.push(...rows.map((row) => row.externalId));
  }
  return present;
}

/** Number of stored boards (diagnostics and tests). */
export async function countAtsBoards(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(atsBoards);
  return row?.n ?? 0;
}
