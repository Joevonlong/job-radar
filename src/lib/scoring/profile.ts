import { ConfigError, parseConfigText, readConfigText, readProfileText, type MeConfig, type PreferencesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getLatestProfileSnapshot, hashProfileYaml, type ProfileSnapshot } from "@/lib/db/repos/profile-snapshots";
import { snapshotForProfileText } from "@/lib/profile/snapshots";

/** me.yaml and preferences.yaml as they are on disk right now, with the exact text (the snapshot hash is taken over it). */
export interface ScoringProfile {
  me: MeConfig;
  preferences: PreferencesConfig;
  meYaml: string;
  preferencesYaml: string;
}

/**
 * Read both profile files from disk (not from the config cache, so the text that is hashed is the
 * text that is used). A missing file is read from `config/profile.example` in memory.
 */
export async function readScoringProfile(): Promise<ScoringProfile> {
  const meYaml = readProfileText("me");
  const preferencesYaml = readProfileText("preferences");
  return { me: parseConfigText("me", meYaml), preferences: parseConfigText("preferences", preferencesYaml), meYaml, preferencesYaml };
}

/** The me.yaml fields scoring needs at least one of. */
export const PROFILE_SCORING_FIELDS = ["summary", "skills"] as const;
export type ProfileScoringField = (typeof PROFILE_SCORING_FIELDS)[number];

/**
 * Why scoring cannot use this profile: the fields to fill in (at least one of them), or `[]` when it can.
 * A profile with neither a summary nor skills tells the model nothing: scoring against it would produce noise.
 */
export function missingProfileFields(me: Pick<MeConfig, "summary" | "skills">): ProfileScoringField[] {
  return me.summary.trim() !== "" || me.skills.length > 0 ? [] : [...PROFILE_SCORING_FIELDS];
}

export function isProfileUsable(profile: Pick<ScoringProfile, "me">): boolean {
  return missingProfileFields(profile.me).length === 0;
}

/** Whether scoring can run with me.yaml as it is on disk; `missing` lists the fields to fill in. */
export interface ProfileReadiness {
  usable: boolean;
  missing: ProfileScoringField[];
}

/**
 * me.yaml read from disk now, for the pages and the doctor. A missing user file counts as incomplete even when runtime
 * readers can use a template; a file that cannot be parsed returns null (the /me page shows that error).
 * Never writes anything.
 */
export function readProfileReadiness(): ProfileReadiness | null {
  let text: string;
  try {
    text = readConfigText("me");
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "missing") return { usable: false, missing: [...PROFILE_SCORING_FIELDS] };
    return null;
  }
  try {
    const missing = missingProfileFields(parseConfigText("me", text));
    return { usable: missing.length === 0, missing };
  } catch {
    return null;
  }
}

async function ensureSnapshot(db: Db, kind: "me" | "preferences", yaml: string): Promise<ProfileSnapshot> {
  const latest = await getLatestProfileSnapshot(db, kind);
  if (latest && latest.hash === hashProfileYaml(yaml)) return latest;
  // The file changed without the web app's save hook (edited by hand, restored, or migrated): record it now, which marks
  // older scores stale, unless only a config migration changed the text (then the snapshot keeps its id)
  return snapshotForProfileText(db, kind, yaml);
}

/**
 * The snapshot id scores are filed under: the preferences snapshot of the file as it is now, the
 * same one the hard filter files its result under, so a job has one `scores` row per
 * preferences snapshot and scoring fills in the row the filter made. The me.yaml snapshot is recorded
 * too: a profile file edited by hand (without the web app's save hook) is noticed here, and every
 * older score is marked stale.
 */
export async function currentPreferencesSnapshotId(db: Db, profile: Pick<ScoringProfile, "meYaml" | "preferencesYaml">): Promise<number> {
  await ensureSnapshot(db, "me", profile.meYaml);
  return (await ensureSnapshot(db, "preferences", profile.preferencesYaml)).id;
}
