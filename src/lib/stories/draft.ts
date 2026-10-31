/**
 * The experience library as the /me form edits it: plain strings ("" = not set), lists as string arrays. Pure functions,
 * shared by the form (client) and the save service (server).
 */
import { z } from "zod";

import { STORY_FILE_BOUNDS, STORY_SOURCES, type StoriesConfig, type Story, type StorySource } from "@/lib/config/schemas/stories";
import type { WriterStoriesLimits } from "@/lib/config/schemas/writer";
import type { FieldError } from "@/lib/profile/draft";

import { findPiiIn, type PiiKind } from "./pii";

export interface StoryDraft {
  /** "" for a story that was never saved: the save gives it an id made from its title. */
  id: string;
  title: string;
  what: string;
  result: string;
  metrics: string[];
  skills: string[];
  period: string;
  language: string;
  tags: string[];
  source: StorySource;
}

export interface StoriesDraft {
  stories: StoryDraft[];
}

export const EMPTY_STORY: StoryDraft = { id: "", title: "", what: "", result: "", metrics: [], skills: [], period: "", language: "", tags: [], source: "manual" };

const text = (max: number) => z.string().max(max);
const list = z.array(text(STORY_FILE_BOUNDS.listItemChars)).max(STORY_FILE_BOUNDS.listItems);

/** What the browser may send: shapes and hard bounds only; the file schema and writer.yaml limits are checked after. */
export const storiesDraftSchema = z.strictObject({
  stories: z
    .array(
      z.strictObject({
        id: text(STORY_FILE_BOUNDS.idChars),
        title: text(STORY_FILE_BOUNDS.titleChars),
        what: text(STORY_FILE_BOUNDS.textChars),
        result: text(STORY_FILE_BOUNDS.textChars),
        metrics: list,
        skills: list,
        period: text(STORY_FILE_BOUNDS.listItemChars),
        language: text(3),
        tags: list,
        source: z.enum(STORY_SOURCES),
      }),
    )
    .max(STORY_FILE_BOUNDS.items),
});

export function storyToDraft(story: Story): StoryDraft {
  return {
    id: story.id,
    title: story.title,
    what: story.what,
    result: story.result ?? "",
    metrics: [...story.metrics],
    skills: [...story.skills],
    period: story.period ?? "",
    language: story.language ?? "",
    tags: [...story.tags],
    source: story.source,
  };
}

export function storiesConfigToDraft(config: StoriesConfig): StoriesDraft {
  return { stories: config.stories.map(storyToDraft) };
}

/** Longest id made from a title (before a "-2" suffix). */
const ID_BASE_CHARS = 48;

/** An id made from `title` that is not in `taken`: ASCII words joined by hyphens, "story" when nothing is left, "-2", "-3" … on a clash. */
export function storyIdFromTitle(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, ID_BASE_CHARS)
      .replace(/^-+|-+$/g, "") || "story";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/**
 * The file value a draft stands for (validated by the caller). Stories keep their id; a new one gets an id from its title,
 * unique among all ids of the draft, and never changes after that.
 */
export function storiesDraftToCandidate(draft: StoriesDraft): { stories: Record<string, unknown>[] } {
  const taken = new Set(draft.stories.map((story) => story.id).filter((id) => id !== ""));
  return {
    stories: draft.stories.map((story) => {
      let id = story.id;
      if (id === "") {
        id = storyIdFromTitle(story.title, taken);
        taken.add(id);
      }
      const candidate: Record<string, unknown> = { id, title: story.title.trim(), what: story.what.trim() };
      const result = optional(story.result);
      if (result !== undefined) candidate.result = result;
      candidate.metrics = cleanList(story.metrics);
      candidate.skills = cleanList(story.skills);
      const period = optional(story.period);
      if (period !== undefined) candidate.period = period;
      const language = optional(story.language);
      if (language !== undefined) candidate.language = language;
      candidate.tags = cleanList(story.tags);
      candidate.source = story.source;
      return candidate;
    }),
  };
}

/** Where a valid library breaks the writer.yaml limits, as form errors (draft paths `stories`, `stories.<i>.<field>`). */
export function storiesLimitProblems(value: StoriesConfig, limits: WriterStoriesLimits): FieldError[] {
  const problems: FieldError[] = [];
  if (value.stories.length > limits.max_items) problems.push({ path: "stories", key: "tooMany", params: { max: limits.max_items } });
  value.stories.forEach((story, index) => {
    const at = (field: string, max: number) => problems.push({ path: `stories.${index}.${field}`, key: "tooLong", params: { max } });
    if (story.title.length > limits.title_max_chars) at("title", limits.title_max_chars);
    if (story.what.length > limits.text_max_chars) at("what", limits.text_max_chars);
    if ((story.result ?? "").length > limits.text_max_chars) at("result", limits.text_max_chars);
    for (const field of ["metrics", "skills", "tags"] as const) {
      if (story[field].some((entry) => entry.length > limits.title_max_chars)) at(field, limits.title_max_chars);
    }
  });
  return problems;
}

/** Contact details that seem to be in a story's text (a warning before saving, never a block). */
export function storyPii(story: StoryDraft): PiiKind[] {
  return findPiiIn([story.title, story.what, story.result, story.period, ...story.metrics, ...story.skills, ...story.tags]);
}
