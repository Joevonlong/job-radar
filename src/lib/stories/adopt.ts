/** Review of the extracted drafts on /me. Adopting goes through the normal stories save, so it detects a file changed elsewhere. Server only. */
import { ConfigError, reloadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { claimStoryDraft, clearAdoptedStoryDraft, listPendingStoryDrafts, releaseStoryDraft, type ProfileStoryDraftRow } from "@/lib/db/repos/story-drafts";
import { saveStories } from "@/lib/profile/service";
import type { ProfileActionState } from "@/lib/profile/types";

import { storiesConfigToDraft } from "./draft";
import { draftToStory, STORY_EXTRACT_ORIGINS, storedStoryDraftSchema, type AdoptedStory, type PendingStoryDraft, type StoryExtractOrigin } from "./extract";

const originOf = (value: string): StoryExtractOrigin | null => STORY_EXTRACT_ORIGINS.find((origin) => origin === value) ?? null;

function toPending(row: ProfileStoryDraftRow): PendingStoryDraft | null {
  const origin = originOf(row.origin);
  const draft = storedStoryDraftSchema.safeParse(row.draft);
  return origin && draft.success ? { id: row.id, origin, createdAt: row.createdAt.toISOString(), draft: draft.data } : null;
}

export async function loadPendingStoryDrafts(db: Db): Promise<PendingStoryDraft[]> {
  return (await listPendingStoryDrafts(db)).flatMap((row) => toPending(row) ?? []);
}

export type AdoptOutcome = { state: "not_found" } | { state: "unreadable" } | { state: "saved"; result: ProfileActionState } | { state: "refused"; result: ProfileActionState };

/**
 * Add a waiting draft to stories.yaml as a new story, as it stands or with your edits. The story gets a new id from its
 * title and its source from the draft's origin, so an existing story is never overwritten. When the save is refused the
 * draft waits again.
 */
export async function adoptStoryDraft(db: Db, input: { draftId: number; baseHash: string; edited?: AdoptedStory | undefined }): Promise<AdoptOutcome> {
  let current;
  try {
    current = storiesConfigToDraft(reloadConfig("stories"));
  } catch (error) {
    if (error instanceof ConfigError) return { state: "unreadable" };
    throw error;
  }
  const row = await claimStoryDraft(db, input.draftId);
  if (!row) return { state: "not_found" };
  const pending = toPending(row);
  if (!pending) {
    await releaseStoryDraft(db, row.id);
    return { state: "not_found" };
  }
  const story = { ...draftToStory(pending.draft, pending.origin), ...input.edited, id: "", source: pending.origin };
  let result: ProfileActionState;
  try {
    result = await saveStories({ stories: [...current.stories, story] }, input.baseHash);
  } catch (error) {
    await releaseStoryDraft(db, row.id);
    throw error;
  }
  if (result.status !== "saved") {
    await releaseStoryDraft(db, row.id);
    return { state: "refused", result };
  }
  await clearAdoptedStoryDraft(db, row.id);
  return { state: "saved", result };
}
