import { createHash } from "node:crypto";

/** SHA-256 (hex) of the job description: a translation is outdated once the description hashes differently. */
export function descriptionHash(description: string | null | undefined): string {
  return createHash("sha256").update(description ?? "", "utf8").digest("hex");
}

/** True when the translation was made from another version of the description than the job has now. */
export function isTranslationStale(translationSourceHash: string, description: string | null | undefined): boolean {
  return translationSourceHash !== descriptionHash(description);
}
