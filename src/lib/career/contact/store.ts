import { parse, stringify } from "yaml";

import { commitConfigFile, sha256 } from "@/lib/config/atomic";
import { ConfigError } from "@/lib/config/errors";
import { readUserFile } from "@/lib/config/read-user-file";
import { withFileLock } from "@/lib/config/write";
import { withConfigWriteLock } from "@/lib/config/write-lock";
import { careerContactSchema, emptyContact, type CareerContact } from "../schema/contact";
import { careerContactPath } from "../store/paths";
import { CareerStoreError } from "./errors";

export async function loadContact(): Promise<{ contact: CareerContact; baseHash: string | null }> {
  try {
    const text = readUserFile(careerContactPath()).toString("utf8");
    return { contact: careerContactSchema.parse(parse(text)), baseHash: sha256(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contact: emptyContact(), baseHash: null };
    throw new CareerStoreError("contact_invalid");
  }
}

export async function saveContact(
  raw: unknown,
  { baseHash }: { baseHash: string | null },
): Promise<{ ok: true; contact: CareerContact; baseHash: string } | { ok: false; code: "stale" }> {
  return withFileLock(careerContactPath(), async () => {
    const parsed = careerContactSchema.safeParse(raw);
    if (!parsed.success) throw new CareerStoreError("contact_invalid");
    const text = stringify(parsed.data);
    try {
      await withConfigWriteLock(
        () => commitConfigFile(careerContactPath(), text, { baseSha256: baseHash }),
        careerContactPath(),
      );
      return { ok: true, contact: parsed.data, baseHash: sha256(text) };
    } catch (error) {
      if (error instanceof ConfigError && error.kind === "stale") return { ok: false, code: "stale" };
      throw new CareerStoreError("write_failed");
    }
  });
}
