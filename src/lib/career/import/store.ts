import { sha256 } from "@/lib/config/atomic";
import { writeCareerDraft } from "../extract/draft-store";
import type { KitImport } from "./kit-yaml";

/** An imported résumé becomes a pending draft under a time-based id, far above the control request ids used by extraction. */
export async function writeKitDraft(kit: KitImport, text: string, now = new Date()): Promise<number | null> {
  if (kit.entries === 0 && !kit.sections.headline && !kit.sections.summary) return null;
  const id = now.getTime();
  await writeCareerDraft({
    schema_version: 1, request_id: id, origin: "imported", source_hash: sha256(text), created_at: now.toISOString(),
    language: kit.language, sections: kit.sections,
  }, async () => true);
  return id;
}
