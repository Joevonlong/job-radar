import { scoreTransaction } from "@/lib/db/repos/current-scores";
import { isDeepStrictEqual } from "node:util";

import { parseConfigText, setOnProfileSaved, type ProfileName } from "@/lib/config";
import {
  countScoresStaleOnChange,
  findProfileSnapshotByHash,
  getDb,
  getLatestProfileSnapshot,
  hashProfileYaml,
  markScoresStaleExcept,
  rebaseProfileSnapshot,
  saveProfileSnapshot,
  switchScoresToSnapshot,
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
    if (previous?.id === snapshot.id) return { snapshot, staleMarked: 0 };
    // scores are filed under preferences snapshots, so only those have rows to bring forward
    const staleMarked = kind === "preferences" ? await switchScoresToSnapshot(tx, snapshot.id) : await markScoresStaleExcept(tx, snapshot.id);
    return { snapshot, staleMarked };
  });
}

/**
 * How many scores saving `yamlText` as me.yaml would newly mark stale, decided branch by branch like
 * `recordProfileSnapshot`: the newest snapshot's text or a text that means the same marks nothing; an older snapshot's text
 * marks the scores of every other snapshot; anything else, also with no snapshot yet, marks every score of a snapshot.
 * Reads only. Scores that finish between this count and the save are marked as well, so the save reports its own number.
 */
export async function previewStaleOnProfileChange(db: Db, yamlText: string): Promise<number> {
  const hash = hashProfileYaml(yamlText);
  const previous = await getLatestProfileSnapshot(db, "me");
  if (previous?.hash === hash) return 0;
  const found = await findProfileSnapshotByHash(db, "me", hash);
  if (found) return found.id === previous?.id ? 0 : countScoresStaleOnChange(db, found.id);
  if (previous && sameProfileValues("me", previous.contentYaml, yamlText)) return 0;
  return countScoresStaleOnChange(db, null);
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
 * The snapshot a profile text is filed under. The same text: its snapshot, which becomes the current version when it was not
 * (the file was edited back to old text by hand: the same as a rollback in the app, so scoring, which goes by the file, and
 * reconciliation, which goes by the newest saved snapshot, agree on the version), unless that text means the same as the current
 * version, which then stays. Text that only a config migration changed
 * (`pnpm config:migrate --write`: preferences.yaml got `market` and renamed values): the newest snapshot, given
 * the new text, so nothing is marked stale and nothing is scored again; the same for a text whose only change is
 * preferences `deal_breakers` (the filter step updates the results in place). Anything else is a real change: a new snapshot,
 * and older scores become stale (`recordProfileSnapshot`).
 */
export async function snapshotForProfileText(db: Db, kind: ScoredProfileName, yamlText: string): Promise<ProfileSnapshot> {
  const found = await findProfileSnapshotByHash(db, kind, hashProfileYaml(yamlText));
  const latest = await getLatestProfileSnapshot(db, kind);
  if (found) {
    if (found.id === latest?.id) return found;
    // an older snapshot has this exact text but the current one means the same: nothing changed, so nothing goes stale
    if (latest && sameProfileValues(kind, latest.contentYaml, yamlText)) return latest;
    return (await recordProfileSnapshot(db, kind, yamlText)).snapshot;
  }
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
    const recorded = await recordProfileSnapshot(getDb(), kind, yamlText);
    return { staleMarked: recorded.staleMarked };
  });
}
