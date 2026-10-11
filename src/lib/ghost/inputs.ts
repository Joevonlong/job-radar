/**
 * From stored rows to what the check reads: which channels count for which signal (their declarations), the trusted posted date
 * (the channel's own `parse` of the stored payload), the repost label, the source of the description and the current breakdown.
 * C1: payloads are only read.
 */
import { createHash } from "node:crypto";

import { parseStoredBreakdown } from "@/lib/breakdown/content";
import type { Channel } from "@/lib/channels/types";
import type { GhostInputRow } from "@/lib/db/repos/ghost";
import { descriptionHash } from "@/lib/translation/hash";

import type { GhostInput, GhostPosting } from "./types";

/** What the check needs of a channel (the registry's `Channel`). */
export type GhostChannel = Pick<Channel, "id" | "stableExternalIds" | "fullDescription" | "trustedPostedAt" | "repostLabel" | "parse">;

/** The channels' declarations for the check. */
export interface GhostChannels {
  stableIds: ReadonlySet<string>;
  fullDescription: ReadonlySet<string>;
  trustedPostedAt: ReadonlySet<string>;
  get(id: string): GhostChannel | undefined;
  /** Channels whose payloads are read (a trusted posted date or a repost label), sorted. */
  payloadChannels: readonly string[];
  /** A hash of the declarations: a channel that changes them checks every job again. */
  key: string;
}

export function ghostChannels(list: readonly GhostChannel[]): GhostChannels {
  const byId = new Map(list.map((channel) => [channel.id, channel]));
  const ids = [...byId.keys()].sort();
  const pick = (test: (channel: GhostChannel) => boolean): Set<string> => new Set(ids.filter((id) => test(byId.get(id) as GhostChannel)));
  const stableIds = pick((c) => c.stableExternalIds === true);
  const fullDescription = pick((c) => c.fullDescription === true);
  const trustedPostedAt = pick((c) => c.trustedPostedAt === true);
  const repost = pick((c) => typeof c.repostLabel === "function");
  const payloadChannels = ids.filter((id) => trustedPostedAt.has(id) || repost.has(id));
  const flags = ids.map((id) => `${id}:${stableIds.has(id) ? "s" : ""}${fullDescription.has(id) ? "f" : ""}${trustedPostedAt.has(id) ? "t" : ""}${repost.has(id) ? "r" : ""}`);
  return {
    stableIds,
    fullDescription,
    trustedPostedAt,
    get: (id) => byId.get(id),
    payloadChannels,
    key: createHash("md5").update(flags.join(",")).digest("hex"),
  };
}

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null; // a payload the channel cannot read gives nothing to the check
  }
}

/** The earliest posted date that a trusted channel's `parse` reads from a stored payload. */
function trustedPostedAtOf(row: GhostInputRow, channels: GhostChannels): GhostInput["trustedPostedAt"] {
  let best: { at: Date; channelId: string } | null = null;
  for (const source of row.sources) {
    if (!channels.trustedPostedAt.has(source.channelId) || source.payload === null || source.payload === undefined) continue;
    const channel = channels.get(source.channelId);
    if (!channel) continue;
    const at = safely(() => channel.parse(source.payload).postedAt ?? null);
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) continue;
    if (best === null || at.getTime() < best.at.getTime()) best = { at, channelId: source.channelId };
  }
  return best;
}

/**
 * The source the description comes from: the job keeps the text of its best-priority source, so all sources of that priority must
 * keep the full text; null when one does not, when there is no source, or when the job has no text.
 */
function descriptionSourceOf(row: GhostInputRow, channels: GhostChannels): GhostInput["descriptionSource"] {
  if (row.description === null || row.description.trim() === "" || row.sources.length === 0) return null;
  const best = Math.min(...row.sources.map((s) => s.priority));
  const top = row.sources.filter((s) => s.priority === best);
  if (!top.every((s) => channels.fullDescription.has(s.channelId))) return null;
  return { channelId: (top[0] as (typeof top)[number]).channelId };
}

/** The duties counted by the AI breakdown of the current description; null without one (or one of another text or version). */
function breakdownResponsibilitiesOf(row: GhostInputRow): number | null {
  const breakdown = row.breakdown;
  if (breakdown === null || breakdown.sourceHash !== descriptionHash(row.description)) return null;
  const content = parseStoredBreakdown(breakdown.promptVersion, breakdown.content);
  return content === null ? null : content.responsibilities.length;
}

export function buildGhostInput(row: GhostInputRow, channels: GhostChannels, trustedKeys: ReadonlySet<string>): GhostInput {
  const postings: GhostPosting[] = row.sources.map((source) => {
    const repost = channels.get(source.channelId)?.repostLabel;
    const label = repost && source.payload !== null && source.payload !== undefined ? safely(() => repost(source.payload)) : null;
    return {
      channelId: source.channelId,
      externalId: source.externalId,
      firstSeenAt: source.firstSeenAt,
      locationLabel: source.locationLabel,
      stableIds: channels.stableIds.has(source.channelId),
      repostLabel: label,
    };
  });
  return {
    jobId: row.jobId,
    status: row.status,
    firstSeenAt: row.firstSeenAt,
    trustedCompany: row.companyNameNorm !== null && trustedKeys.has(row.companyNameNorm),
    trustedPostedAt: trustedPostedAtOf(row, channels),
    description: row.description,
    descriptionSource: descriptionSourceOf(row, channels),
    postings,
    breakdownResponsibilities: breakdownResponsibilitiesOf(row),
  };
}
