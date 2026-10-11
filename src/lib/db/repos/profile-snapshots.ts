import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { profileSnapshots } from "../schema";

export type ProfileSnapshot = typeof profileSnapshots.$inferSelect;
export type ProfileSnapshotKind = ProfileSnapshot["kind"];

/** SHA-256 hex of the YAML text; the (kind, hash) pair is unique in `profile_snapshots`. */
export function hashProfileYaml(contentYaml: string): string {
  return createHash("sha256").update(contentYaml, "utf8").digest("hex");
}

/**
 * Store a snapshot of `contentYaml`. Identical content of the same kind is never stored twice:
 * the existing row is returned and its `saved_at` moves to now, so the history list is ordered by
 * "last saved" (rolling back to an old version brings it to the top).
 */
export async function saveProfileSnapshot(db: Db, kind: ProfileSnapshotKind, contentYaml: string): Promise<ProfileSnapshot> {
  const hash = hashProfileYaml(contentYaml);
  const [row] = await db
    .insert(profileSnapshots)
    .values({ kind, contentYaml, hash })
    .onConflictDoUpdate({
      target: [profileSnapshots.kind, profileSnapshots.hash],
      set: { savedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("saveProfileSnapshot: upsert returned no row");
  return row;
}

/** Newest first (by last save time, then id). */
export async function listProfileSnapshots(db: Db, kind: ProfileSnapshotKind, limit: number): Promise<ProfileSnapshot[]> {
  return db
    .select()
    .from(profileSnapshots)
    .where(eq(profileSnapshots.kind, kind))
    .orderBy(desc(profileSnapshots.savedAt), desc(profileSnapshots.id))
    .limit(limit);
}

/** The snapshot with this id, but only when it is of the given kind. */
export async function getProfileSnapshot(db: Db, kind: ProfileSnapshotKind, id: number): Promise<ProfileSnapshot | null> {
  const [row] = await db
    .select()
    .from(profileSnapshots)
    .where(and(eq(profileSnapshots.kind, kind), eq(profileSnapshots.id, id)))
    .limit(1);
  return row ?? null;
}

/** The stored snapshot of this exact content, without touching its `saved_at`. */
export async function findProfileSnapshotByHash(db: Db, kind: ProfileSnapshotKind, hash: string): Promise<ProfileSnapshot | null> {
  const [row] = await db
    .select()
    .from(profileSnapshots)
    .where(and(eq(profileSnapshots.kind, kind), eq(profileSnapshots.hash, hash)))
    .limit(1);
  return row ?? null;
}

/**
 * Give a stored snapshot new text that means the same (a config migration rewrote the file): the id stays, so
 * the scores filed under it stay current. The caller has checked that no snapshot of the new text exists.
 */
export async function rebaseProfileSnapshot(db: Db, id: number, contentYaml: string): Promise<ProfileSnapshot> {
  const [row] = await db.update(profileSnapshots).set({ contentYaml, hash: hashProfileYaml(contentYaml) }).where(eq(profileSnapshots.id, id)).returning();
  if (!row) throw new Error("rebaseProfileSnapshot: no such snapshot");
  return row;
}

/** The snapshot of this kind that was saved last (the file's current version), or null when there is none. */
export async function getLatestProfileSnapshot(db: Db, kind: ProfileSnapshotKind): Promise<ProfileSnapshot | null> {
  const [row] = await listProfileSnapshots(db, kind, 1);
  return row ?? null;
}
