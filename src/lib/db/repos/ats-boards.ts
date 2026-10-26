import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { atsBoards, rawPostings } from "../schema";

// Format version of the stored validator; bumping it discards ETags and id lists remembered under older semantics.
export const BOARD_STATE_VERSION = "3";

export type AtsBoardRow = typeof atsBoards.$inferSelect;
export type AtsBoardStatus = "ok" | "not_modified" | "short" | "error";

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

/** Discard legacy complete-read evidence and its validator without changing any other board state. */
export async function invalidateAtsBoardEvidence(db: Db, key: AtsBoardKey): Promise<void> {
  await db
    .update(atsBoards)
    .set({ lastOkAt: null, etag: null })
    .where(and(eq(atsBoards.ats, key.ats), eq(atsBoards.token, key.token)));
}

export interface AtsBoardUpdate {
  status: AtsBoardStatus;
  /** Only meaningful for `ok`; every other status leaves the stored validator alone. */
  etag?: string | null;
  filterFingerprint?: string;
  externalIds?: readonly string[];
  /** Replaced by `ok`; `short` and `error` replace it only when supplied; `not_modified` leaves it alone. */
  detailRetryIds?: readonly string[];
  /** Defaults to true for `ok` / `not_modified`; false preserves only current-version `last_ok_at` (NULL on a new row). Ignored otherwise. */
  completeRead?: boolean;
  total?: number;
  kept?: number;
  errorCode?: string | null;
  checkedAt?: Date;
}

/**
 * Record one board check. `ok` replaces the complete-list validator, fingerprint, ids, retries and counts
 * (a response without a usable ETag clears the old one). `not_modified` leaves that state alone;
 * `short` and `error` only stamp the check and replace retries when supplied. `ok` / `not_modified`
 * reset failures and advance `last_ok_at` unless `completeRead` is false because details remain unresolved.
 * `error` adds a failure; `short` preserves the failure count. Neither advances complete-read evidence.
 * Checks without a complete read discard evidence from missing or outdated fingerprints.
 */
export async function recordAtsBoardCheck(db: Db, key: AtsBoardKey, update: AtsBoardUpdate): Promise<void> {
  // Use the database clock for last_checked_at / last_ok_at on purpose: offline-evidence SQL joins them to runs.started_at.
  const checkedAt = update.checkedAt ?? sql`now()`;
  const completeRead = update.completeRead !== false;
  // The earlier invalidation can fail: discard legacy evidence atomically using the pre-update fingerprint,
  // even when this check replaces that fingerprint with the current version.
  const retainedLastOkAt = sql`case
    when ${atsBoards.filterFingerprint} like ${`${BOARD_STATE_VERSION}:%`} then ${atsBoards.lastOkAt}
    else null
  end`;
  if (update.status === "ok") {
    const values = {
      etag: update.etag ?? null,
      filterFingerprint: update.filterFingerprint ?? null,
      externalIds: [...(update.externalIds ?? [])],
      detailRetryIds: [...(update.detailRetryIds ?? [])],
      lastStatus: "ok",
      lastErrorCode: null,
      lastCheckedAt: checkedAt,
      lastChangedAt: checkedAt,
      lastTotal: update.total ?? 0,
      lastKept: update.kept ?? 0,
      consecutiveFailures: 0,
    };
    await db
      .insert(atsBoards)
      .values({ ...key, ...values, lastOkAt: completeRead ? checkedAt : null })
      .onConflictDoUpdate({
        target: [atsBoards.ats, atsBoards.token],
        set: { ...values, lastOkAt: completeRead ? checkedAt : retainedLastOkAt },
      });
    return;
  }
  const stamp = {
    lastStatus: update.status,
    lastErrorCode: update.status === "error" ? (update.errorCode ?? "unknown") : null,
    lastCheckedAt: checkedAt,
    ...(update.status !== "not_modified" && update.detailRetryIds !== undefined
      ? { detailRetryIds: [...update.detailRetryIds] }
      : {}),
  };
  const failed = update.status === "error";
  const unchanged = update.status === "not_modified";
  await db
    .insert(atsBoards)
    .values({ ...key, ...stamp, consecutiveFailures: failed ? 1 : 0, lastOkAt: unchanged && completeRead ? checkedAt : null })
    .onConflictDoUpdate({
      target: [atsBoards.ats, atsBoards.token],
      set: {
        ...stamp,
        ...(failed ? { consecutiveFailures: sql`${atsBoards.consecutiveFailures} + 1` } : {}),
        ...(unchanged ? { consecutiveFailures: 0 } : {}),
        lastOkAt: unchanged && completeRead ? checkedAt : retainedLastOkAt,
      },
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
