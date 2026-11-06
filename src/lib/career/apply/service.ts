/**
 * Apply to matching: project the career profile onto me.yaml (what scoring reads) and stories.yaml (what the writer reads),
 * one way and only when the user confirms. The preview reads only. The confirmation recomputes everything and writes nothing
 * when any of its bases changed since the preview: the three file hashes and the number of scores the change would mark
 * stale (a score that finished in between changes that number without touching a file). It then saves through the /me
 * services, so me.yaml gets its snapshot and stale marks like any other save.
 */
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { ConfigError, getConfigPath, parseConfigText, readProfileText, reloadConfig } from "@/lib/config";
import type { MeConfig } from "@/lib/config/schemas/me";
import type { StoriesConfig } from "@/lib/config/schemas/stories";
import { WRITER_STORIES_DEFAULTS, type WriterStoriesLimits } from "@/lib/config/schemas/writer";
import { getDb, hashProfileYaml, type Db } from "@/lib/db";
import { meConfigToDraft } from "@/lib/profile/draft";
import { saveProfile, saveStories } from "@/lib/profile/service";
import { previewStaleOnProfileChange } from "@/lib/profile/snapshots";
import { storiesConfigToDraft } from "@/lib/stories/draft";
import { figures } from "@/lib/writer/verify";
import { stringify } from "yaml";

import { toOutbound } from "../ai/outbound";
import { CareerStoreError } from "../contact/errors";
import { hasCareerContent } from "../schema/profile";
import { loadApplyState, saveApplyState } from "../store/apply-state";
import { loadCareerProfile } from "../store/profile";
import { applyMeSelection, defaultMeSelection, ME_FIELDS, projectMe, type MeProjection, type MeSelection } from "./project-me";
import { applyStoriesSelection, defaultStoriesSelection, projectStories, type StoriesProjection, type StoriesSelection } from "./project-stories";

const idList = z.array(z.string().max(200)).max(5000);
export const applySelectionSchema = z.strictObject({
  me: z.strictObject(Object.fromEntries(ME_FIELDS.map((field) => [field, z.boolean()])) as Record<(typeof ME_FIELDS)[number], z.ZodBoolean>),
  stories: z.strictObject({ write: idList, remove: idList }),
});
export type ApplySelection = z.infer<typeof applySelectionSchema>;

export const applyBasesSchema = z.strictObject({
  profile: z.string().max(200),
  me: z.string().max(200),
  stories: z.string().max(200),
  staleCount: z.number().int().min(0),
});
export type ApplyBases = z.infer<typeof applyBasesSchema>;

export type ApplyErrorCode = "me_required" | "profile_empty" | "too_many";

export interface ApplyPreview {
  me: MeProjection;
  stories: StoriesProjection;
  selection: ApplySelection;
  /** Scores the selected me.yaml change would mark stale now. */
  staleCount: number;
  /** Nothing selected changes a file. */
  noChanges: boolean;
  /** The library after the selected changes would hold more stories than writer.yaml `stories.max_items`. */
  tooMany: boolean;
  maxItems: number;
  bases: ApplyBases;
}

export type FileOutcome = "written" | "unchanged" | "failed" | "snapshot_failed" | "stale";

export type ApplyConfirmResult =
  | { status: "error"; code: ApplyErrorCode }
  | { status: "stale"; preview: ApplyPreview }
  | {
      status: "applied";
      me: FileOutcome;
      stories: FileOutcome;
      /** Scores this apply actually marked stale; null when unknown (the snapshot step failed). */
      staleMarked: number | null;
      /** What the preview said; differs from `staleMarked` when a score finished during the confirmation. */
      staleExpected: number;
    };

interface Inputs {
  profile: Awaited<ReturnType<typeof loadCareerProfile>>;
  me: MeConfig;
  meHash: string;
  stories: StoriesConfig;
  storiesHash: string;
  limits: WriterStoriesLimits;
}

function storiesLimits(): WriterStoriesLimits {
  try {
    return reloadConfig("writer").stories;
  } catch {
    return WRITER_STORIES_DEFAULTS;
  }
}

/** The user's own me.yaml, or null when there is none yet (reading would fall back to the shipped template). */
function readMeFile(): string | null {
  if (!fs.existsSync(/*turbopackIgnore: true*/ getConfigPath("me"))) return null;
  try {
    return readProfileText("me");
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "missing") return null;
    throw error;
  }
}

async function readInputs(): Promise<Inputs | ApplyErrorCode> {
  const meText = readMeFile();
  if (meText === null) return "me_required";
  const storiesText = readProfileText("stories");
  const profile = await loadCareerProfile();
  if (profile.baseHash === null || !hasCareerContent(profile.profile)) return "profile_empty";
  return {
    profile,
    me: parseConfigText("me", meText) as MeConfig,
    meHash: hashProfileYaml(meText),
    stories: parseConfigText("stories", storiesText) as StoriesConfig,
    storiesHash: hashProfileYaml(storiesText),
    limits: storiesLimits(),
  };
}

function scrub(text: string): string {
  return toOutbound(text);
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function project(inputs: Inputs, now: Date): { me: MeProjection; stories: StoriesProjection } {
  return {
    me: projectMe(inputs.profile.profile, inputs.me, today(now), scrub),
    stories: projectStories({
      profile: inputs.profile.profile,
      current: inputs.stories.stories,
      limits: inputs.limits,
      scrub,
      figures: (text) => figures(text).shown,
    }),
  };
}

function plan(inputs: Inputs, projection: { me: MeProjection; stories: StoriesProjection }, selection: ApplySelection) {
  const me = applyMeSelection(inputs.me, projection.me, selection.me as MeSelection);
  const stories = applyStoriesSelection(inputs.stories.stories, projection.stories, selection.stories as StoriesSelection);
  return { me, stories, meChanged: !isDeepStrictEqual(me, inputs.me), storiesChanged: !isDeepStrictEqual(stories, inputs.stories.stories) };
}

async function buildPreview(db: Db, inputs: Inputs, now: Date, requested: ApplySelection | null): Promise<ApplyPreview> {
  const projection = project(inputs, now);
  const selection: ApplySelection = requested ?? { me: defaultMeSelection(projection.me), stories: defaultStoriesSelection(projection.stories) };
  const planned = plan(inputs, projection, selection);
  const staleCount = planned.meChanged ? await previewStaleOnProfileChange(db, stringify(planned.me)) : 0;
  return {
    ...projection,
    selection,
    staleCount,
    noChanges: !planned.meChanged && !planned.storiesChanged,
    tooMany: planned.stories.length > inputs.limits.max_items,
    maxItems: inputs.limits.max_items,
    bases: { profile: inputs.profile.baseHash ?? "", me: inputs.meHash, stories: inputs.storiesHash, staleCount },
  };
}

/** The preview for `selection` (the defaults when null). Reads only. Throws CareerStoreError / ConfigError for unreadable files. */
export async function previewApply(selection: ApplySelection | null, now = new Date(), db: Db = getDb()): Promise<ApplyPreview | { error: ApplyErrorCode }> {
  const inputs = await readInputs();
  if (typeof inputs === "string") return { error: inputs };
  return buildPreview(db, inputs, now, selection);
}

function outcome(state: Awaited<ReturnType<typeof saveProfile>>): FileOutcome {
  if (state.status === "saved") return "written";
  if (state.status === "error" && state.formError === "snapshotFailed") return "snapshot_failed";
  if (state.status === "error" && state.formError === "stale") return "stale";
  return "failed";
}

/**
 * Write what the user confirmed. Any base that changed since the preview: `stale` with a new preview, nothing written. me.yaml
 * is written before stories.yaml; each result is reported on its own, and applying again is idempotent.
 */
export async function confirmApply(selection: ApplySelection, bases: ApplyBases, now = new Date(), db: Db = getDb()): Promise<ApplyConfirmResult> {
  const inputs = await readInputs();
  if (typeof inputs === "string") return { status: "error", code: inputs };
  const preview = await buildPreview(db, inputs, now, selection);
  if (!isDeepStrictEqual(preview.bases, bases)) return { status: "stale", preview };
  if (preview.tooMany) return { status: "error", code: "too_many" };
  const planned = plan(inputs, { me: preview.me, stories: preview.stories }, selection);
  let me: FileOutcome = "unchanged";
  let staleMarked: number | null = 0;
  if (planned.meChanged) {
    const state = await saveProfile("me", meConfigToDraft(planned.me), bases.me);
    me = outcome(state);
    staleMarked = state.status === "saved" ? (state.staleMarked ?? null) : me === "snapshot_failed" ? null : 0;
  }
  let stories: FileOutcome = "unchanged";
  if (planned.storiesChanged) stories = outcome(await saveStories(storiesConfigToDraft({ stories: planned.stories }), bases.stories));
  if (me !== "failed" && me !== "stale" && stories !== "failed" && stories !== "stale") {
    try {
      await saveApplyState(bases.profile, now);
    } catch (error) {
      if (!(error instanceof CareerStoreError)) throw error;
    }
  }
  return { status: "applied", me, stories, staleMarked, staleExpected: preview.staleCount };
}

/** The profile changed since it was last applied to matching (false when it never was). */
export function changedSinceApply(profileHash: string | null): boolean {
  const state = loadApplyState();
  return state !== null && profileHash !== null && state.profile_hash !== profileHash;
}
