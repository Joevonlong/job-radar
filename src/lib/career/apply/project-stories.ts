/**
 * One experience-library story per profile experience, identified as `career-<entry id without its prefix>` with source
 * `profile`: the title is "Company – Role", "what" the summary and bullets, metrics the figures found in them, skills the
 * stack, period the dates. Texts arrive through `scrub` and are cut to the writer.yaml story limits after that. The user's
 * own stories are never touched; a profile story the user may have edited is offered unchecked; one whose entry left the
 * profile is kept unless the user removes it. Pure.
 */
import { isDeepStrictEqual } from "node:util";

import type { Story } from "@/lib/config/schemas/stories";
import type { WriterStoriesLimits } from "@/lib/config/schemas/writer";

import { primaryText, type CareerProfile } from "../schema/profile";

export const PROFILE_STORY_PREFIX = "career-";

export type StoryChangeKind = "new" | "changed" | "unchanged" | "removed";

export interface StoryChange {
  id: string;
  kind: StoryChangeKind;
  current: Story | null;
  proposed: Story | null;
  defaultSelected: boolean;
  truncated: boolean;
}

export interface StoriesProjection {
  changes: StoryChange[];
  /** Experience entries with neither a summary nor bullets: no story is made for them. */
  notApplied: string[];
}

export interface StoriesSelection {
  /** Ids of new or changed stories to write. */
  write: string[];
  /** Ids of profile stories whose entry left the profile, to remove. */
  remove: string[];
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max).trimEnd(), truncated: true };
}

/** Summary first, then bullets, each kept whole while it fits; only a first part that alone is too long is cut. */
function whatText(parts: readonly string[], max: number): { text: string; truncated: boolean } {
  let text = "";
  for (const part of parts) {
    const next = text === "" ? part : `${text}\n${part}`;
    if (next.length <= max) {
      text = next;
      continue;
    }
    if (text === "") return cut(part, max);
    return { text, truncated: true };
  }
  return { text, truncated: false };
}

function period(start: string | null, end: string | null): string | undefined {
  if (start === null && end === null) return undefined;
  if (start === null) return end ?? undefined;
  return end === null || end === start ? start : `${start} – ${end}`;
}

export interface ProjectStoriesInput {
  profile: CareerProfile;
  current: readonly Story[];
  limits: WriterStoriesLimits;
  scrub: (text: string) => string;
  /** The figures written in a text, as they appear in it. */
  figures: (text: string) => string[];
}

/** The profile stories as they would be now, compared with the library. */
export function projectStories({ profile, current, limits, scrub, figures }: ProjectStoriesInput): StoriesProjection {
  const byId = new Map(current.map((story) => [story.id, story]));
  const changes: StoryChange[] = [];
  const notApplied: string[] = [];
  const projected = new Set<string>();
  const fits = (item: string) => item !== "" && item.length <= limits.title_max_chars;
  for (const entry of profile.experience) {
    const role = scrub(primaryText(entry.role)).trim();
    const company = scrub(entry.company).trim();
    const parts = [primaryText(entry.summary), ...entry.bullets.map((bullet) => primaryText(bullet))]
      .map((part) => scrub(part).trim())
      .filter((part) => part !== "");
    const label = [company, role].filter((part) => part !== "").join(" – ");
    if (parts.length === 0 || label === "") {
      notApplied.push(label || entry.id);
      continue;
    }
    const title = cut(label, limits.title_max_chars);
    const what = whatText(parts, limits.text_max_chars);
    const allMetrics = [...new Set(parts.flatMap((part) => figures(part)).map((figure) => figure.trim()))].filter((item) => item !== "");
    const allSkills = [...new Set(entry.stack.map((item) => scrub(item).trim()))].filter((item) => item !== "");
    const metrics = allMetrics.filter(fits);
    const skills = allSkills.filter(fits);
    const id = `${PROFILE_STORY_PREFIX}${entry.id.replace(/^exp_/, "")}`;
    projected.add(id);
    const when = period(entry.start, entry.end);
    const proposed: Story = { id, title: title.text, what: what.text, metrics, skills, tags: [], source: "profile", ...(when === undefined ? {} : { period: when }) };
    const truncated = title.truncated || what.truncated || metrics.length < allMetrics.length || skills.length < allSkills.length;
    const existing = byId.get(id) ?? null;
    if (existing === null) changes.push({ id, kind: "new", current: null, proposed, defaultSelected: true, truncated });
    else if (isDeepStrictEqual(existing, proposed)) changes.push({ id, kind: "unchanged", current: existing, proposed, defaultSelected: false, truncated });
    else changes.push({ id, kind: "changed", current: existing, proposed, defaultSelected: false, truncated });
  }
  for (const story of current) {
    if (story.source === "profile" && story.id.startsWith(PROFILE_STORY_PREFIX) && !projected.has(story.id)) {
      changes.push({ id: story.id, kind: "removed", current: story, proposed: null, defaultSelected: false, truncated: false });
    }
  }
  return { changes, notApplied };
}

export function defaultStoriesSelection(projection: StoriesProjection): StoriesSelection {
  return {
    write: projection.changes.filter((change) => (change.kind === "new" || change.kind === "changed") && change.defaultSelected).map((change) => change.id),
    remove: projection.changes.filter((change) => change.kind === "removed" && change.defaultSelected).map((change) => change.id),
  };
}

/** The library with the selected changes: changed stories replaced in place, new ones appended, removed ones dropped. */
export function applyStoriesSelection(current: readonly Story[], projection: StoriesProjection, selection: StoriesSelection): Story[] {
  const write = new Set(selection.write);
  const remove = new Set(selection.remove);
  const proposals = new Map(projection.changes.filter((change) => change.proposed !== null && (change.kind === "new" || change.kind === "changed") && write.has(change.id)).map((change) => [change.id, change.proposed as Story]));
  const removable = new Set(projection.changes.filter((change) => change.kind === "removed" && remove.has(change.id)).map((change) => change.id));
  const next = current.filter((story) => !removable.has(story.id)).map((story) => proposals.get(story.id) ?? story);
  const known = new Set(current.map((story) => story.id));
  for (const [id, story] of proposals) if (!known.has(id)) next.push(story);
  return next;
}
