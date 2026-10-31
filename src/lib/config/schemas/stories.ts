import { z } from "zod";

import { nonEmptyString } from "./common";

/** Where a story came from: written on /me, or adopted from a draft the AI extracted from one of these sources. */
export const STORY_SOURCES = ["manual", "profile", "self_description", "resume"] as const;
export type StorySource = (typeof STORY_SOURCES)[number];

/**
 * Hard bounds of the file format. The (smaller) limits a save must meet are in writer.yaml `stories` and are checked by the
 * save service, so this schema never depends on another config file: a file written under larger limits still loads.
 */
export const STORY_FILE_BOUNDS = { items: 1000, idChars: 80, titleChars: 1000, textChars: 20_000, listItems: 50, listItemChars: 500 } as const;

/** A story id: lowercase ASCII words joined by single hyphens (`led-billing-migration`). Stable once created. */
export const STORY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const optionalText = z.string().trim().min(1).max(STORY_FILE_BOUNDS.textChars).optional();
const textList = z.array(nonEmptyString.max(STORY_FILE_BOUNDS.listItemChars)).max(STORY_FILE_BOUNDS.listItems).default([]);

export const storySchema = z.strictObject({
  id: z.string().max(STORY_FILE_BOUNDS.idChars).regex(STORY_ID_PATTERN, "must be lowercase letters, digits and single hyphens"),
  title: nonEmptyString.max(STORY_FILE_BOUNDS.titleChars),
  /** What you did. */
  what: nonEmptyString.max(STORY_FILE_BOUNDS.textChars),
  /** What came of it. */
  result: optionalText,
  /** Figures as you would state them ("build time from 40 to 12 minutes"). */
  metrics: textList,
  skills: textList,
  /** Free text ("2021–2023", "spring 2024"). */
  period: z.string().trim().min(1).max(STORY_FILE_BOUNDS.listItemChars).optional(),
  /** Language code of the text (ISO 639, 2-3 lowercase letters). */
  language: z.string().regex(/^[a-z]{2,3}$/, "language code must be 2-3 lowercase letters").optional(),
  tags: textList,
  source: z.enum(STORY_SOURCES).default("manual"),
});
export type Story = z.infer<typeof storySchema>;

/** data/profile/stories.yaml — the experience library: one entry per project or achievement. */
export const storiesSchema = z.strictObject({
  stories: z
    .array(storySchema)
    .max(STORY_FILE_BOUNDS.items)
    .superRefine((stories, ctx) => {
      const seen = new Set<string>();
      stories.forEach((story, index) => {
        if (seen.has(story.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate id "${story.id}"` });
        seen.add(story.id);
      });
    }),
});
export type StoriesConfig = z.infer<typeof storiesSchema>;
