/** Data for the /me page (server only): the profile files, their history and the stale-score count. */
import { aiDisclosure } from "@/lib/ai/disclosure";
import type { AiProviderId } from "@/lib/ai/types";
import { diffYaml, reloadConfig, readProfileText, type ProfileName, type WriterConfig } from "@/lib/config";
import { WRITER_STORIES_DEFAULTS, writerSchema, type StoryImportFormat, type WriterStoriesLimits } from "@/lib/config/schemas/writer";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { readLatestStoryExtract, type StoryExtractErrorCode } from "@/lib/control/story-extract-request";
import { deleteExpiredStoryDrafts } from "@/lib/db/repos/story-drafts";
import { loadPendingStoryDrafts } from "@/lib/stories/adopt";
import type { PendingStoryDraft } from "@/lib/stories/extract";
import { storiesConfigToDraft, type StoriesDraft } from "@/lib/stories/draft";
import { readCareerGate } from "@/lib/config/career-gate";
import { countStaleScores, getDb, hashProfileYaml, listProfileSnapshots, type ProfileSnapshot } from "@/lib/db";

import {
  meConfigToDraft,
  preferencesConfigToDraft,
  type MeDraft,
  type PreferencesDraft,
} from "./draft";
import type { HistoryEntry, ProfileSection } from "./types";

/** How many snapshots the history list shows per file. */
export const HISTORY_LIMIT = 20;
export { diffYaml };

export interface StoryImportView {
  /** writer.yaml says the writer is on: otherwise nothing can be sent. */
  enabled: boolean;
  /** writer.yaml `import`, as the card shows and pre-checks it. */
  maxFileBytes: number;
  maxChars: number;
  formats: StoryImportFormat[];
  ttlDays: number;
  /** The providers the `story_extract` task may go to, in order. */
  providers: AiProviderId[];
  /** Empty while the database cannot be reached. */
  drafts: PendingStoryDraft[];
  /** The extraction still running, to follow after a reload. */
  open: { requestId: number; stage: "pending" | "running"; queue: ControlQueueView | null } | null;
  error: StoryExtractErrorCode | null;
  /** The career profile is on: extraction moved to the career page, this card only finishes what is already here. */
  careerEnabled: boolean;
}

async function loadStoryImport(dbAvailable: boolean): Promise<StoryImportView> {
  let writer: WriterConfig | null = null;
  try {
    writer = reloadConfig("writer");
  } catch {
    // an unreadable writer.yaml is reported by its settings tab; nothing can be sent meanwhile
  }
  const limits = writer?.import ?? writerSchema.parse({}).import;
  let providers: AiProviderId[] = [];
  try {
    providers = aiDisclosure(reloadConfig("ai")).find((row) => row.task === "story_extract")?.providers ?? [];
  } catch {
    // an unreadable ai.yaml is reported by its settings tab
  }
  let drafts: PendingStoryDraft[] = [];
  let open: StoryImportView["open"] = null;
  let error: StoryImportView["error"] = null;
  if (dbAvailable) {
    try {
      const db = getDb();
      await deleteExpiredStoryDrafts(db, limits.draft_ttl_days);
      const [pending, latest] = await Promise.all([loadPendingStoryDrafts(db), readLatestStoryExtract(db)]);
      drafts = pending;
      if (latest?.state === "waiting") open = { requestId: latest.requestId, stage: latest.stage, queue: latest.queue };
      if (latest?.state === "failed" && latest.error === "preview_required") error = latest.error;
    } catch {
      // not migrated yet, or gone since the first read: the card shows no drafts
    }
  }
  const careerEnabled = (await readCareerGate()).enabled;
  return { careerEnabled, enabled: writer?.enabled ?? false, maxFileBytes: limits.max_file_bytes, maxChars: limits.max_chars, formats: limits.formats, ttlDays: limits.draft_ttl_days, providers, drafts, open, error };
}

export interface ProfilePageData {
  me: ProfileSection<MeDraft>;
  preferences: ProfileSection<PreferencesDraft>;
  stories: ProfileSection<StoriesDraft>;
  /** writer.yaml `stories` (the form's length hints), or its defaults when writer.yaml cannot be read. */
  storyLimits: WriterStoriesLimits;
  /** Extracting stories from your profile, a text or a résumé, and the drafts waiting for review. */
  storyImport: StoryImportView;
  staleScores: number;
  /** False when the database could not be reached: history and stale count are unavailable. */
  dbAvailable: boolean;
}

/** Newest-first snapshots -> list entries with the diff against the next older snapshot. */
export function buildHistory(snapshots: readonly ProfileSnapshot[], currentHash: string | null, limit = HISTORY_LIMIT): HistoryEntry[] {
  return snapshots.slice(0, limit).map((snapshot, index) => {
    const older = snapshots[index + 1];
    return {
      id: snapshot.id,
      savedAt: snapshot.savedAt.toISOString(),
      current: snapshot.hash === currentHash,
      diff: older ? diffYaml(older.contentYaml, snapshot.contentYaml) : null,
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function loadSection<D>(
  kind: ProfileName,
  toDraft: () => D,
  snapshots: readonly ProfileSnapshot[],
): Promise<ProfileSection<D>> {
  let hash = "";
  let currentHash: string | null = null;
  try {
    hash = hashProfileYaml(readProfileText(kind));
    currentHash = hash;
  } catch {
    // unreadable file: reported through loadError below
  }
  try {
    const draft = toDraft();
    return { kind, hash, draft, loadError: null, history: buildHistory(snapshots, currentHash) };
  } catch (error) {
    return { kind, hash, draft: null, loadError: errorMessage(error), history: buildHistory(snapshots, currentHash) };
  }
}

export async function loadProfilePage(): Promise<ProfilePageData> {
  let dbAvailable = true;
  let staleScores = 0;
  let meSnapshots: ProfileSnapshot[] = [];
  let preferenceSnapshots: ProfileSnapshot[] = [];
  let storySnapshots: ProfileSnapshot[] = [];
  try {
    const db = getDb();
    // One extra row so the last visible entry still has an older neighbour to diff against.
    [meSnapshots, preferenceSnapshots, storySnapshots, staleScores] = await Promise.all([
      listProfileSnapshots(db, "me", HISTORY_LIMIT + 1),
      listProfileSnapshots(db, "preferences", HISTORY_LIMIT + 1),
      listProfileSnapshots(db, "stories", HISTORY_LIMIT + 1),
      countStaleScores(db),
    ]);
  } catch {
    dbAvailable = false;
  }

  const [me, preferences, stories] = await Promise.all([
    loadSection("me", () => meConfigToDraft(reloadConfig("me")), meSnapshots),
    loadSection("preferences", () => preferencesConfigToDraft(reloadConfig("preferences")), preferenceSnapshots),
    loadSection("stories", () => storiesConfigToDraft(reloadConfig("stories")), storySnapshots),
  ]);
  let storyLimits: WriterStoriesLimits = WRITER_STORIES_DEFAULTS;
  try {
    storyLimits = reloadConfig("writer").stories;
  } catch {
    // an unreadable writer.yaml is reported by its settings tab; the save uses the same defaults
  }
  return { me, preferences, stories, storyLimits, storyImport: await loadStoryImport(dbAvailable), staleScores, dbAvailable };
}
