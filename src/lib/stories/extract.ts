/**
 * Story extraction: the drafts the AI extracts from your profile, a text or a résumé, as they wait for review on /me.
 * Every field keeps its quote from the source and the result of the check (`verify-extract.ts`). Pure: the browser reads it too.
 */
import { z } from "zod";

import { STORY_FILE_BOUNDS } from "@/lib/config/schemas/stories";

import { EMPTY_STORY, type StoryDraft } from "./draft";

/** Where a draft's text came from; also the `source` of the story once adopted. */
export const STORY_EXTRACT_ORIGINS = ["profile", "self_description", "resume"] as const;
export type StoryExtractOrigin = (typeof STORY_EXTRACT_ORIGINS)[number];

/** Hard bound of a request's text (the upper bound of `writer.yaml: import.max_chars`). */
export const STORY_EXTRACT_MAX_CHARS = 200_000;

/** Why a field is flagged. `figure_missing`: the value has a figure its quote does not have. */
export const EXTRACT_FLAGS = ["quote_missing", "quote_too_short", "figure_missing"] as const;
export type ExtractFlag = (typeof EXTRACT_FLAGS)[number];

const storedFieldSchema = z.object({
  value: z.string(),
  quote: z.string(),
  /** Null: the field passed the check. */
  flag: z.enum(EXTRACT_FLAGS).nullable(),
  /** The figures of the value its quote lacks (`figure_missing`). */
  missing: z.array(z.string()).default([]),
});
export type StoredExtractField = z.infer<typeof storedFieldSchema>;

export const storedStoryDraftSchema = z.object({
  title: storedFieldSchema,
  what: storedFieldSchema,
  result: storedFieldSchema.nullable(),
  period: storedFieldSchema.nullable(),
  metrics: z.array(storedFieldSchema),
  skills: z.array(storedFieldSchema),
  language: z.string().nullable(),
});
export type StoredStoryDraft = z.infer<typeof storedStoryDraftSchema>;

/** One draft waiting for review, as the page shows it. */
export interface PendingStoryDraft {
  id: number;
  origin: StoryExtractOrigin;
  createdAt: string;
  draft: StoredStoryDraft;
}

/** The fields of a draft, flagged or not. */
export function draftFields(draft: StoredStoryDraft): StoredExtractField[] {
  return [draft.title, draft.what, ...(draft.result ? [draft.result] : []), ...(draft.period ? [draft.period] : []), ...draft.metrics, ...draft.skills];
}

export function countFlags(draft: StoredStoryDraft): number {
  return draftFields(draft).filter((field) => field.flag !== null).length;
}

/** The form value a draft stands for. It has no id yet, so adopting it can only add a story, never replace one. */
export function draftToStory(draft: StoredStoryDraft, origin: StoryExtractOrigin): StoryDraft {
  return {
    ...EMPTY_STORY,
    title: draft.title.value,
    what: draft.what.value,
    result: draft.result?.value ?? "",
    period: draft.period?.value ?? "",
    metrics: draft.metrics.map((field) => field.value),
    skills: draft.skills.map((field) => field.value),
    language: draft.language ?? "",
    source: origin,
  };
}

/** A story as the review form sends it: edited text, but the id and the source are the server's. */
export const adoptedStorySchema = z.strictObject({
  title: z.string().max(STORY_FILE_BOUNDS.titleChars),
  what: z.string().max(STORY_FILE_BOUNDS.textChars),
  result: z.string().max(STORY_FILE_BOUNDS.textChars),
  period: z.string().max(STORY_FILE_BOUNDS.listItemChars),
  metrics: z.array(z.string().max(STORY_FILE_BOUNDS.listItemChars)).max(STORY_FILE_BOUNDS.listItems),
  skills: z.array(z.string().max(STORY_FILE_BOUNDS.listItemChars)).max(STORY_FILE_BOUNDS.listItems),
  language: z.string().max(3),
});
export type AdoptedStory = z.infer<typeof adoptedStorySchema>;
