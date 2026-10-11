import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import { ATS_KINDS, ATS_REGIONS } from "@/lib/config";

/**
 * What a board posting is stored as in `raw_postings.payload_json`: the posting exactly as the ATS
 * delivered it (C1), wrapped with the board it came from, because `parse` only receives the payload
 * and needs the company name.
 */
export const atsEnvelopeSchema = z.object({
  source: z.object({
    ats: z.enum(ATS_KINDS),
    token: z.string().min(1),
    companyName: z.string().min(1),
    region: z.enum(ATS_REGIONS).optional(),
  }),
  posting: z.unknown(),
});
export type AtsEnvelope = z.infer<typeof atsEnvelopeSchema>;
export type AtsSource = AtsEnvelope["source"];

export function wrapPosting(source: AtsSource, posting: unknown): AtsEnvelope {
  return { source, posting };
}

/** The envelope of a stored payload; `ChannelError("parse")` when it is not one (or comes from the other ATS). */
export function unwrapPayload(payload: unknown, ats: AtsSource["ats"]): AtsEnvelope {
  const parsed = atsEnvelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.source.ats !== ats) {
    throw new ChannelError("parse", `payload is not a ${ats} posting envelope`);
  }
  return parsed.data;
}

/**
 * The posting of a stored envelope parsed with `schema`, or null when the payload is not this ATS's envelope or the posting
 * does not match (the trap scan then has no HTML of this source; it never throws).
 */
export function readEnvelopePosting<T>(payload: unknown, ats: AtsSource["ats"], schema: z.ZodType<T>): T | null {
  const parsed = atsEnvelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.source.ats !== ats) return null;
  const posting = schema.safeParse(parsed.data.posting);
  return posting.success ? posting.data : null;
}

/** The non-empty HTML parts as `descriptionHtml` fragments. */
export function htmlFragments(parts: ReadonlyArray<{ path: string; html: string | null | undefined; escaped?: boolean }>): Array<{ path: string; html: string; escaped?: boolean }> {
  return parts.flatMap((part) => (part.html && part.html.trim() !== "" ? [{ path: part.path, html: part.html, ...(part.escaped ? { escaped: true } : {}) }] : []));
}

/** First `n` zod issue paths, for error messages (never the values). */
export function issuePaths(error: z.ZodError, n = 5): string {
  return error.issues
    .slice(0, n)
    .map((i) => i.path.join(".") || "(root)")
    .join(", ");
}
