import { parse, stringify } from "yaml";
import { z } from "zod";

import { commitConfigFile } from "@/lib/config/atomic";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { CareerStoreError } from "../contact/errors";
import { careerApplyStatePath } from "./paths";

const applyStateSchema = z.strictObject({
  schema_version: z.literal(1),
  profile_hash: z.string().min(1).max(200),
  applied_at: z.iso.datetime({ offset: true }),
});
export type ApplyState = z.infer<typeof applyStateSchema>;

/** The profile version last applied to matching; null when it never was or the file cannot be read (it only drives a hint). */
export function loadApplyState(): ApplyState | null {
  try {
    return applyStateSchema.parse(parse(readUserFile(careerApplyStatePath()).toString("utf8")));
  } catch {
    return null;
  }
}

export async function saveApplyState(profileHash: string, appliedAt: Date): Promise<void> {
  const text = stringify({ schema_version: 1, profile_hash: profileHash, applied_at: appliedAt.toISOString() });
  await withFileLock(careerApplyStatePath(), async () => {
    try {
      await withConfigWriteLock(() => commitConfigFile(careerApplyStatePath(), text, {}), careerApplyStatePath());
    } catch {
      throw new CareerStoreError("write_failed");
    }
  });
}
