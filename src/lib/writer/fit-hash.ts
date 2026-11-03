/** How a stored fit note is told to be out of date: a newer search of the company, or a story it was made from changed or gone. */
import type { Story } from "@/lib/config";

import { stableHash } from "./hash";
import { storySnapshot } from "./snapshot";

export function fitStoriesHash(stories: readonly unknown[]): string {
  return stableHash(stories);
}

export function fitNoteOutdated(note: { companyResearchId: number; materialsHash: string; storyIds: unknown }, currentResearchId: number | null, stories: readonly Story[]): boolean {
  if (note.companyResearchId !== currentResearchId) return true;
  const ids = Array.isArray(note.storyIds) ? note.storyIds : [];
  const current = ids.flatMap((id) => {
    const story = stories.find((entry) => entry.id === id);
    return story ? [storySnapshot(story)] : [];
  });
  return fitStoriesHash(current) !== note.materialsHash;
}
