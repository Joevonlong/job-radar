/** The stored selection of a question (`application_questions.selected_materials`), read leniently: what does not parse is dropped. */
import { z } from "zod";

import { EMPTY_SELECTION, type QuestionSelection } from "./types";

export const questionSelectionSchema = z.object({
  jdPoints: z.array(z.strictObject({ quote: z.string().min(1).max(2000), offset: z.number().int().min(0) })).max(200).catch([]),
  useJdText: z.boolean().catch(EMPTY_SELECTION.useJdText),
  storyIds: z.array(z.string().min(1).max(80)).max(1000).catch([]),
  profile: z.boolean().catch(EMPTY_SELECTION.profile),
  emphasis: z.string().max(5000).catch(""),
});

export function parseSelection(value: unknown): QuestionSelection {
  const parsed = questionSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...EMPTY_SELECTION };
}

/**
 * The stories a new question starts with selected: those sharing the most skills with the job (case-insensitive), best
 * first, library order on a tie, at most `count`. Stories sharing none are not preselected.
 */
export function preselectStories(stories: ReadonlyArray<{ id: string; skills: readonly string[] }>, jobSkills: readonly string[], count: number): string[] {
  const wanted = new Set(jobSkills.map((skill) => skill.trim().toLowerCase()));
  return stories
    .map((story, index) => ({ id: story.id, index, overlap: new Set(story.skills.map((skill) => skill.trim().toLowerCase()).filter((skill) => wanted.has(skill))).size }))
    .filter((story) => story.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map((story) => story.id);
}
