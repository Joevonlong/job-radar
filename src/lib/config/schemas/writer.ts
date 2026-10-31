import { z } from "zod";

import { STORY_FILE_BOUNDS } from "./stories";

export const WRITER_STORIES_DEFAULTS = { max_items: 60, title_max_chars: 120, text_max_chars: 1500, preselect_count: 4 } as const;

/**
 * config/writer.yaml: the application writer and its experience library (`data/profile/stories.yaml`). Every key has a
 * default, so a missing file or section means "off" and the defaults below.
 */
export const writerSchema = z.strictObject({
  /** Off by default: nothing of the writer is sent to an AI provider until this is true. */
  enabled: z.boolean().default(false),
  /** Limits a save of the experience library must meet (the file format itself allows more). */
  stories: z
    .strictObject({
      /** Most stories in the library. */
      max_items: z.number().int().min(1).max(STORY_FILE_BOUNDS.items).default(WRITER_STORIES_DEFAULTS.max_items),
      /** Longest title; also the longest entry of a story's metrics, skills and tags. */
      title_max_chars: z.number().int().min(10).max(STORY_FILE_BOUNDS.listItemChars).default(WRITER_STORIES_DEFAULTS.title_max_chars),
      /** Longest "what you did" and "result" text. */
      text_max_chars: z.number().int().min(100).max(STORY_FILE_BOUNDS.textChars).default(WRITER_STORIES_DEFAULTS.text_max_chars),
      /** How many stories a new application question starts with selected (best skill overlap with the job first). */
      preselect_count: z.number().int().min(0).max(50).default(WRITER_STORIES_DEFAULTS.preselect_count),
    })
    .default(WRITER_STORIES_DEFAULTS),
});

export type WriterConfig = z.infer<typeof writerSchema>;
export type WriterStoriesLimits = WriterConfig["stories"];
