import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { copyPrivateIfMissing } from "./private-file";
import { getConfigPath, getProfileDir, getProfileExampleDir } from "./paths";
import { configRegistry, PROFILE_NAMES, type ProfileName } from "./registry";

export type ProfileSavedHook = (kind: ProfileName, yamlText: string) => Promise<void>;

let onProfileSaved: ProfileSavedHook = async () => {};

/** Inject the hook called after a profile file was written (the profile snapshot store saves a snapshot in the DB). Default: no-op. */
export function setOnProfileSaved(hook: ProfileSavedHook | null): void {
  onProfileSaved = hook ?? (async () => {});
}

export async function notifyProfileSaved(kind: ProfileName, yamlText: string): Promise<void> {
  await onProfileSaved(kind, yamlText);
}

export interface EnsureProfileResult {
  name: ProfileName;
  path: string;
  created: boolean;
}

/** The profile files `ensureProfileFiles` would create now. Reads only. */
export function ensureProfileFilesPlan(): ProfileName[] {
  return PROFILE_NAMES.filter((name) => !fs.existsSync(/*turbopackIgnore: true*/ getConfigPath(name)) && fs.existsSync(/*turbopackIgnore: true*/ path.join(getProfileExampleDir(), configRegistry[name].file)));
}

/**
 * Copy `<defaults dir>/profile.example/{me,preferences,stories}.yaml` into the profile directory for every file
 * that does not exist yet. Existing files are never overwritten.
 */
export async function ensureProfileFiles(): Promise<EnsureProfileResult[]> {
  const results: EnsureProfileResult[] = [];
  for (const name of PROFILE_NAMES) {
    const target = getConfigPath(name);
    if (fs.existsSync(/*turbopackIgnore: true*/ target)) {
      results.push({ name, path: target, created: false });
      continue;
    }
    await fsp.mkdir(getProfileDir(), { recursive: true });
    const source = path.join(getProfileExampleDir(), configRegistry[name].file);
    // personal data: owner-only from the first byte (the template's 0644 is not copied)
    const created = await copyPrivateIfMissing(source, target);
    results.push({ name, path: target, created });
  }
  return results;
}
