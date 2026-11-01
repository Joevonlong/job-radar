/** Reading the stored sentences of a version (`application_answer_versions.sentences`, C6): a row that does not parse shows as one unchecked text. */
import { z } from "zod";

import { EVIDENCE_SOURCES, SENTENCE_ABOUT, SENTENCE_STATUSES, type CheckedSentence } from "./types";

const checkedSentenceSchema = z.object({
  text: z.string(),
  newParagraph: z.boolean().catch(false),
  about: z.enum(SENTENCE_ABOUT).catch("framing"),
  status: z.enum(SENTENCE_STATUSES),
  evidence: z
    .array(
      z.object({
        source: z.enum(EVIDENCE_SOURCES),
        ref: z.string().optional(),
        quote: z.string(),
        problem: z.enum(["not_found", "not_allowed", "no_ref", "unknown_ref"]).nullable(),
      }),
    )
    .catch([]),
  missing: z.array(z.string()).catch([]),
  needsCheck: z.array(z.string()).catch([]),
});

export function parseStoredSentences(value: unknown, text: string): CheckedSentence[] {
  const parsed = z.array(checkedSentenceSchema).safeParse(value);
  if (parsed.success) return parsed.data.map((sentence) => ({ ...sentence, evidence: sentence.evidence.map(({ ref, ...entry }) => (ref === undefined ? entry : { ...entry, ref })) }));
  return [{ text, newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [] }];
}
