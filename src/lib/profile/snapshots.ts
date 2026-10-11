import { isDeepStrictEqual } from "node:util";

import { parseConfigText, setOnProfileSaved, type ProfileName } from "@/lib/config";
import {
  findProfileSnapshotByHash,
  getDb,
  getLatestProfileSnapshot,
  hashProfileYaml,
  markScoresStaleExcept,
  rebaseProfileSnapshot,
  saveProfileSnapshot,
  type Db,
  type ProfileSnapshot,
} from "@/lib/db";

export interface RecordedSnapshot {
  snapshot: ProfileSnapshot;
  /** Scores newly marked stale because they were computed from another snapshot. */
  staleMarked: number;
}

/**
 * Store a snapshot of a saved profile file and flag every score that was computed from another
 * snapshot as stale (the scorer re-scores those). One transaction: either both happen or neither.
 * Identical content is not stored twice (same snapshot id), so a no-op save marks nothing: saving
 * the version the file already has (its newest snapshot) is not a change, even when the scores
 * point at the snapshot of the other profile file.
 */
export async function recordProfileSnapshot(db: Db, kind: ProfileName, yamlText: string): Promise<RecordedSnapshot> {
  return db.transaction(async (tx) => {
    const previous = await getLatestProfileSnapshot(tx, kind);
    const snapshot = await saveProfileSnapshot(tx, kind, yamlText);
    const staleMarked = previous?.id === snapshot.id ? 0 : await markScoresStaleExcept(tx, snapshot.id);
    return { snapshot, staleMarked };
  });
}

/** Both texts are valid and mean the same values (after the in-memory config migration). */
function sameProfileValues(kind: ProfileName, a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(parseConfigText(kind, a, kind), parseConfigText(kind, b, kind));
  } catch {
    return false;
  }
}

/**
 * The snapshot a profile text is filed under. The same text: its snapshot. Text that only a config migration changed
 * (`pnpm config:migrate --write`: preferences.yaml got `market` and renamed values): the newest snapshot, given
 * the new text, so nothing is marked stale and nothing is scored again. Anything else is a real change: a new snapshot,
 * and older scores become stale (`recordProfileSnapshot`).
 */
export async function snapshotForProfileText(db: Db, kind: ProfileName, yamlText: string): Promise<ProfileSnapshot> {
  const found = await findProfileSnapshotByHash(db, kind, hashProfileYaml(yamlText));
  if (found) return found;
  const latest = await getLatestProfileSnapshot(db, kind);
  if (latest && sameProfileValues(kind, latest.contentYaml, yamlText)) return rebaseProfileSnapshot(db, latest.id, yamlText);
  return (await recordProfileSnapshot(db, kind, yamlText)).snapshot;
}

let registered = false;

/**
 * Make `writeConfig` of me.yaml / preferences.yaml record a snapshot. Idempotent; only the web
 * process calls it (it is the only writer of the profile files).
 */
export function registerProfileSnapshotHook(): void {
  if (registered) return;
  registered = true;
  setOnProfileSaved(async (kind, yamlText) => {
    await recordProfileSnapshot(getDb(), kind, yamlText);
  });
}
