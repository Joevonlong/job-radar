import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getTranslator } from "../i18n/node";
import { ConfigError } from "./errors";
import { assertConfigWritable } from "./write-lock";
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

/**
 * Copy `<defaults dir>/profile.example/{me,preferences}.yaml` into the profile directory for every file
 * that does not exist yet. Existing files are never overwritten.
 */
export async function ensureProfileFiles(): Promise<EnsureProfileResult[]> {
  try {
    assertConfigWritable(getProfileDir());
    return await fillProfileFiles();
  } catch (error) {
    if (!(error instanceof ConfigError) || error.kind !== "frozen") throw error;
    console.info(getTranslator("configOps", "cli")("fillsSkipped"));
    return [];
  }
}

async function fillProfileFiles(): Promise<EnsureProfileResult[]> {
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
