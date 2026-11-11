import { parse, stringify } from "yaml";

import { commitConfigFile, sha256 } from "@/lib/config/atomic";
import { ConfigError } from "@/lib/config/errors";
import { reloadConfig } from "@/lib/config/load";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { preferencesSchema, type CareerPreferences } from "../schema/preferences";
import { careerPreferencesPath } from "./paths";

export async function loadPreferences(): Promise<{ preferences: CareerPreferences; baseHash: string | null }> {
  try {
    const bytes = readUserFile(careerPreferencesPath());
    return { preferences: preferencesSchema.parse(parse(bytes.toString("utf8"))), baseHash: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CareerStoreError("preferences_invalid");
    return {
      preferences: preferencesSchema.parse({ schema_version: 1, layout: reloadConfig("career").document.defaults, emphasis: null, tone: null }),
      baseHash: null,
    };
  }
}

export async function savePreferences(
  raw: unknown,
  { baseHash }: { baseHash: string | null },
): Promise<{ ok: true; preferences: CareerPreferences; baseHash: string } | { ok: false; code: "stale" }> {
  return withFileLock(careerPreferencesPath(), async () => {
    const result = preferencesSchema.safeParse(raw);
    if (!result.success) throw new CareerStoreError("preferences_invalid");
    const text = stringify(result.data);
    try {
      await withConfigWriteLock(() => commitConfigFile(careerPreferencesPath(), text, { baseSha256: baseHash }), careerPreferencesPath());
    } catch (error) {
      if (error instanceof ConfigError && error.kind === "stale") return { ok: false, code: "stale" };
      throw new CareerStoreError("write_failed");
    }
    return { ok: true, preferences: result.data, baseHash: sha256(text) };
  });
}
