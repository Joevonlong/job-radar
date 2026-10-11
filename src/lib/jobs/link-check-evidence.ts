/** `jobs.link_check_json`, what the last recheck of a watched job's posting found; read with zod (it is stored JSON, C6). */
import { z } from "zod";

export const linkCheckEvidenceSchema = z.object({
  outcome: z.enum(["alive", "gone", "phrase", "unknown", "robots"]),
  httpStatus: z.number().int().nullable(),
  phrase: z.string().nullable(),
  quote: z.string().nullable(),
  url: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
});
export type LinkCheckEvidence = z.infer<typeof linkCheckEvidenceSchema>;

/** The stored evidence, or null when there is none or it does not read. */
export function parseLinkCheck(value: unknown): LinkCheckEvidence | null {
  const parsed = linkCheckEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
