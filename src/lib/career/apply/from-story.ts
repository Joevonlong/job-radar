/**
 * Story to profile: a story from the experience library becomes a new bullet or summary wording on one experience entry.
 * The wording records the story id. Stories written by apply to matching (the `career-` prefix) are never offered, so a
 * profile text cannot loop back into the profile. The stories file is only read.
 */
import fs from "node:fs";
import { z } from "zod";

import { getConfigPath, parseConfigText, readProfileText } from "@/lib/config";
import type { StoriesConfig, Story } from "@/lib/config/schemas/stories";
import { findPiiIn } from "@/lib/stories/pii";
import { CareerStoreError } from "../contact/errors";
import { normalizeCareerContent } from "../extract/match";
import { careerProfileSchema, CAREER_FILE_BOUNDS, type CareerProfile, type Text } from "../schema/profile";
import { PROFILE_STORY_PREFIX } from "./project-stories";

export const fromStoryInputSchema = z.strictObject({
  storyId: z.string().min(1).max(200),
  experienceId: z.string().regex(/^exp_[a-z2-7]{10}$/),
  target: z.enum(["bullet", "summary"]),
});
export type FromStoryInput = z.infer<typeof fromStoryInputSchema>;
export interface StoryOption { id: string; title: string; text: string; pii: boolean }

/** The user's own stories; without a stories file there are none (reading would fall back to the shipped template). */
export function readUserStories(): Story[] {
  if (!fs.existsSync(/*turbopackIgnore: true*/ getConfigPath("stories"))) return [];
  return (parseConfigText("stories", readProfileText("stories")) as StoriesConfig).stories;
}

export function storyText(story: Story): string {
  return [story.what, story.result].filter(Boolean).join(" ").slice(0, CAREER_FILE_BOUNDS.textChars);
}

export function storyOptions(stories: readonly Story[]): StoryOption[] {
  return stories.filter((story) => !story.id.startsWith(PROFILE_STORY_PREFIX)).map((story) => {
    const text = storyText(story);
    return { id: story.id, title: story.title, text, pii: findPiiIn([story.title, text]).length > 0 };
  });
}

/** Returns the profile with the story text added, or the same profile when that text is already on the entry. */
export function addStoryToProfile(profile: CareerProfile, stories: readonly Story[], input: FromStoryInput, now: string): { profile: CareerProfile; changed: boolean } {
  const story = stories.find((item) => item.id === input.storyId && !item.id.startsWith(PROFILE_STORY_PREFIX));
  if (!story) throw new CareerStoreError("unknown_id");
  const result = structuredClone(profile);
  const entry = result.experience.find((item) => item.id === input.experienceId);
  if (!entry) throw new CareerStoreError("unknown_id");
  const text = storyText(story);
  const wording = { id: "", text, lang: story.language ?? null, label: null, origin: "from_story" as const, from_document: null, from_story: story.id, created_at: now };
  const same = (candidate: Text | null) => candidate?.wordings.some((item) => normalizeCareerContent(item.text) === normalizeCareerContent(text)) ?? false;
  if (input.target === "summary") {
    if (same(entry.summary)) return { profile, changed: false };
    if (entry.summary) entry.summary.wordings.push(wording);
    else entry.summary = { id: "", primary: "", wordings: [wording] };
  } else {
    if (entry.bullets.some(same)) return { profile, changed: false };
    entry.bullets.push({ id: "", primary: "", wordings: [wording] });
  }
  return { profile: careerProfileSchema.parse(result), changed: true };
}
