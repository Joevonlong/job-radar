import fsp from "node:fs/promises";
import { parse, stringify } from "yaml";

import { reloadConfig } from "@/lib/config/load";
import { commitConfigFile, sha256 } from "@/lib/config/atomic";
import { ConfigError } from "@/lib/config/errors";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import {
  careerProfileSchema,
  checkProfileLimits,
  emptyProfile,
  parseStoredProfile,
  profileContent,
  type CareerProfile,
} from "../schema/profile";
import { assignIds } from "../schema/ids";
import { prune, writeVersion } from "./history";
import { careerHistoryDir, careerProfilePath } from "./paths";

export interface LoadedCareerProfile {
  profile: CareerProfile;
  baseHash: string | null;
  updatedAt: string | null;
}
export type CareerSaveResult =
  { ok: true; profile: CareerProfile; baseHash: string; warnings: "history_failed"[] } | { ok: false; code: "stale" };

export async function loadCareerProfile(): Promise<LoadedCareerProfile> {
  try {
    const file = careerProfilePath();
    const text = readUserFile(file).toString("utf8");
    const profile = parseStoredProfile(parse(text));
    return { profile, baseHash: sha256(text), updatedAt: (await fsp.stat(file)).mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profile: emptyProfile(), baseHash: null, updatedAt: null };
    }
    throw new CareerStoreError("profile_invalid");
  }
}

/** The profile commits first. A failed history write cannot turn a successful profile commit into a failed save. */
export async function saveCareerProfile(
  rawProfile: unknown,
  options: { baseHash: string | null },
): Promise<CareerSaveResult> {
  return persistProfile(rawProfile, options, false);
}

async function persistProfile(
  rawProfile: unknown,
  { baseHash }: { baseHash: string | null },
  restore: boolean,
): Promise<CareerSaveResult> {
  return withFileLock(careerProfilePath(), async () => {
    const current = await loadCareerProfile();
    if (baseHash !== current.baseHash) return { ok: false, code: "stale" };
    const parsed = careerProfileSchema.safeParse(rawProfile);
    if (!parsed.success) throw new CareerStoreError("profile_invalid");
    parsed.data.adopted_entries = [...new Set([...current.profile.adopted_entries, ...parsed.data.adopted_entries])];
    const config = reloadConfig("career");
    checkProfileLimits(parsed.data, config.profile);
    const profile = restore ? parseStoredProfile(parsed.data) : assignIds(parsed.data, current.profile);
    const text = serializeProfile(profile);
    const unchanged = current.baseHash !== null && serializeProfile(current.profile) === text;
    try {
      await withConfigWriteLock(async () => {
        if (unchanged) {
          if (sha256(readUserFile(careerProfilePath())) !== baseHash) {
            throw new ConfigError({ configName: "career", filePath: careerProfilePath(), kind: "stale" });
          }
        } else {
          await commitConfigFile(careerProfilePath(), text, { baseSha256: baseHash });
        }
      }, careerProfilePath());
    } catch (error) {
      if (error instanceof ConfigError && error.kind === "stale") return { ok: false, code: "stale" };
      throw new CareerStoreError("write_failed");
    }
    if (unchanged) return { ok: true, profile, baseHash: current.baseHash!, warnings: [] };
    const warnings: "history_failed"[] = [];
    try {
      await withConfigWriteLock(async () => {
        if (!isCurrentProfile(text)) return;
        await writeVersion(text);
        await prune(config.history.keep_versions);
      }, careerHistoryDir());
    } catch {
      warnings.push("history_failed");
    }
    return { ok: true, profile, baseHash: sha256(text), warnings };
  });
}

function serializeProfile(profile: CareerProfile): string {
  return stringify(profile.adopted_entries.length ? profile : profileContent(profile));
}

/**
 * The history lock is taken after the profile lock is released, so another process may delete or replace the profile in
 * between. A version is recorded only while the committed text is still the current profile, so deleted data is never
 * written back.
 */
function isCurrentProfile(text: string): boolean {
  try {
    return sha256(readUserFile(careerProfilePath())) === sha256(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A restore trusts the stored ids and keeps adoption keys from both profiles when committing the restored content. */
export async function restoreCareerProfile(
  profile: CareerProfile,
  options: { baseHash: string | null },
): Promise<CareerSaveResult> {
  return persistProfile(profile, options, true);
}
