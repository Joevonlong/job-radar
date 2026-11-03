/**
 * A coach review as stored on the reviewed version (`application_answer_versions.coach`) and read back: parsed with zod (C6),
 * a row that does not parse shows as no review. Pure; client-safe.
 */
import { z } from "zod";

import { checkedSentenceSchema } from "./stored";
import { COACH_STATUSES, type CheckedSentence, type CoachStatus } from "./types";

const storedCoachSchema = z.object({
  /** The AI's judgement, 0-100. */
  score: z.number().min(0).max(100),
  dimensions: z.array(z.object({ id: z.string(), status: z.enum(COACH_STATUSES), note: z.string() })),
  suggestions: z.array(
    z.object({
      /** The sentence of the reviewed version it is about, from 0. */
      sentenceIndex: z.number().int().min(0),
      issue: z.string(),
      /** The rewrite as the evidence check saw it (its text is the suggested sentence). */
      sentence: checkedSentenceSchema,
    }),
  ),
  /** Dimensions the AI rated that writer.yaml does not list, and suggestions that named no sentence of the answer (both left out). */
  dropped: z.object({ dimensions: z.number().int().min(0), suggestions: z.number().int().min(0) }).catch({ dimensions: 0, suggestions: 0 }),
  provider: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  promptVersion: z.string().nullable().catch(null),
  /** ISO time. */
  createdAt: z.string(),
});

export interface StoredCoach {
  score: number;
  dimensions: { id: string; status: CoachStatus; note: string }[];
  suggestions: { sentenceIndex: number; issue: string; sentence: CheckedSentence }[];
  dropped: { dimensions: number; suggestions: number };
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
}

export function parseStoredCoach(value: unknown): StoredCoach | null {
  if (value === null || value === undefined) return null;
  const parsed = storedCoachSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    suggestions: parsed.data.suggestions.map((suggestion) => ({
      ...suggestion,
      sentence: { ...suggestion.sentence, evidence: suggestion.sentence.evidence.map(({ ref, ...entry }) => (ref === undefined ? entry : { ...entry, ref })) },
    })),
  };
}

/**
 * The version a suggestion makes when adopted: the reviewed version's sentences with the suggested one in place of the
 * sentence it is about (its check result is the suggestion's). Null when the version has no such sentence.
 */
export function applySuggestion(sentences: readonly CheckedSentence[], suggestion: StoredCoach["suggestions"][number]): CheckedSentence[] | null {
  const target = sentences[suggestion.sentenceIndex];
  if (!target) return null;
  return sentences.map((sentence, index) => (index === suggestion.sentenceIndex ? { ...suggestion.sentence, newParagraph: target.newParagraph } : sentence));
}

/**
 * What a review or rewrite may quote from the version under review as "your draft": its sentences you wrote or that had
 * evidence of their own. Sentences without evidence, partly backed ones and unchecked AI suggestions are left out, or a
 * sentence the AI made up would back itself by quoting itself. One sentence per line, so no quote spans two.
 */
export function trustedDraftText(sentences: readonly CheckedSentence[]): string {
  return sentences
    .filter((sentence) => sentence.status === "supported" || sentence.status === "user_written")
    .map((sentence) => sentence.text)
    .join("\n");
}
