/** Data for the /me page (server only): both profile files, their history and the stale-score count. */
import { diffYaml, reloadConfig, readProfileText, type ProfileName } from "@/lib/config";
import { countStaleScores, getDb, hashProfileYaml, listProfileSnapshots, type ProfileSnapshot } from "@/lib/db";

import {
  meConfigToDraft,
  preferencesConfigToDraft,
  type MeDraft,
  type PreferencesDraft,
} from "./draft";
import type { HistoryEntry, ProfileSection } from "./types";

/** How many snapshots the history list shows per file. */
export const HISTORY_LIMIT = 20;
export { diffYaml };

export interface ProfilePageData {
  me: ProfileSection<MeDraft>;
  preferences: ProfileSection<PreferencesDraft>;
  staleScores: number;
  /** False when the database could not be reached: history and stale count are unavailable. */
  dbAvailable: boolean;
}

/** Newest-first snapshots -> list entries with the diff against the next older snapshot. */
export function buildHistory(snapshots: readonly ProfileSnapshot[], currentHash: string | null, limit = HISTORY_LIMIT): HistoryEntry[] {
  return snapshots.slice(0, limit).map((snapshot, index) => {
    const older = snapshots[index + 1];
    return {
      id: snapshot.id,
      savedAt: snapshot.savedAt.toISOString(),
      current: snapshot.hash === currentHash,
      diff: older ? diffYaml(older.contentYaml, snapshot.contentYaml) : null,
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function loadSection<D>(
  kind: ProfileName,
  toDraft: () => D,
  snapshots: readonly ProfileSnapshot[],
): Promise<ProfileSection<D>> {
  let hash = "";
  let currentHash: string | null = null;
  try {
    hash = hashProfileYaml(readProfileText(kind));
    currentHash = hash;
  } catch {
    // unreadable file: reported through loadError below
  }
  try {
    const draft = toDraft();
    return { kind, hash, draft, loadError: null, history: buildHistory(snapshots, currentHash) };
  } catch (error) {
    return { kind, hash, draft: null, loadError: errorMessage(error), history: buildHistory(snapshots, currentHash) };
  }
}

export async function loadProfilePage(): Promise<ProfilePageData> {
  let dbAvailable = true;
  let staleScores = 0;
  let meSnapshots: ProfileSnapshot[] = [];
  let preferenceSnapshots: ProfileSnapshot[] = [];
  try {
    const db = getDb();
    // One extra row so the last visible entry still has an older neighbour to diff against.
    [meSnapshots, preferenceSnapshots, staleScores] = await Promise.all([
      listProfileSnapshots(db, "me", HISTORY_LIMIT + 1),
      listProfileSnapshots(db, "preferences", HISTORY_LIMIT + 1),
      countStaleScores(db),
    ]);
  } catch {
    dbAvailable = false;
  }

  const [me, preferences] = await Promise.all([
    loadSection("me", () => meConfigToDraft(reloadConfig("me")), meSnapshots),
    loadSection("preferences", () => preferencesConfigToDraft(reloadConfig("preferences")), preferenceSnapshots),
  ]);
  return { me, preferences, staleScores, dbAvailable };
}
