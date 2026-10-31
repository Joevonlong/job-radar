import { scoreTransaction } from "@/lib/db/repos/current-scores";
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

/** The profile files scoring reads; only their snapshots make scores stale. */
export type ScoredProfileName = Exclude<ProfileName, "stories">;

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
 * point at the snapshot of the other profile file. A save that changes nothing the scoring reads (only
 * preferences `deal_breakers`, which the hard filter applies in place) keeps the newest snapshot, given the new text.
 */
export async function recordProfileSnapshot(db: Db, kind: ScoredProfileName, yamlText: string): Promise<RecordedSnapshot> {
  return scoreTransaction(db, async (tx) => {
    const previous = await getLatestProfileSnapshot(tx, kind);
    if (previous && previous.hash !== hashProfileYaml(yamlText) && !(await findProfileSnapshotByHash(tx, kind, hashProfileYaml(yamlText))) && sameProfileValues(kind, previous.contentYaml, yamlText)) {
      return { snapshot: await rebaseProfileSnapshot(tx, previous.id, yamlText), staleMarked: 0 };
    }
    const snapshot = await saveProfileSnapshot(tx, kind, yamlText);
    const staleMarked = previous?.id === snapshot.id ? 0 : await markScoresStaleExcept(tx, snapshot.id);
    return { snapshot, staleMarked };
  });
}

/**
 * The values of a profile text that count as "the profile": everything except preferences `deal_breakers` (veto rules
 * of the hard filter: not in any prompt, applied to the existing results in place, so a change of them alone must
 * not make scores stale).
 */
function profileValues(kind: ScoredProfileName, text: string): unknown {
  const value = parseConfigText(kind, text, kind);
  if (kind !== "preferences") return value;
  const { deal_breakers: _ignored, ...rest } = value as Record<string, unknown>;
  void _ignored;
  return rest;
}

/** Both texts are valid and mean the same profile values (after the in-memory config migration, ignoring `deal_breakers`). */
function sameProfileValues(kind: ScoredProfileName, a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(profileValues(kind, a), profileValues(kind, b));
  } catch {
    return false;
  }
}

/**
 * The snapshot a profile text is filed under. The same text: its snapshot. Text that only a config migration changed
 * (`pnpm config:migrate --write`: preferences.yaml got `market` and renamed values): the newest snapshot, given
 * the new text, so nothing is marked stale and nothing is scored again; the same for a text whose only change is
 * preferences `deal_breakers` (the filter step updates the results in place). Anything else is a real change: a new snapshot,
 * and older scores become stale (`recordProfileSnapshot`).
 */
export async function snapshotForProfileText(db: Db, kind: ScoredProfileName, yamlText: string): Promise<ProfileSnapshot> {
  const found = await findProfileSnapshotByHash(db, kind, hashProfileYaml(yamlText));
  if (found) return found;
  const latest = await getLatestProfileSnapshot(db, kind);
  if (latest && sameProfileValues(kind, latest.contentYaml, yamlText)) return rebaseProfileSnapshot(db, latest.id, yamlText);
  return (await recordProfileSnapshot(db, kind, yamlText)).snapshot;
}

let registered = false;

/**
 * Make `writeConfig` of a profile file record a snapshot. Idempotent; only the web process calls it (it is the only writer
 * of the profile files). stories.yaml is not read by scoring: its snapshot is only stored (history and rollback on /me),
 * never rebased and never marks a score stale.
 */
export function registerProfileSnapshotHook(): void {
  if (registered) return;
  registered = true;
  setOnProfileSaved(async (kind, yamlText) => {
    if (kind === "stories") {
      await saveProfileSnapshot(getDb(), kind, yamlText);
      return;
    }
    await recordProfileSnapshot(getDb(), kind, yamlText);
  });
}
