/**
 * What the posted-date strip of a job needs to know, from stored rows only. "Posted" is always `jobs.posted_at`, the earliest
 * posted date over all sources; a relisting under a new link is a separate fact (the day we first saw the new link, not a date
 * the source gave) and never replaces it.
 */
import { isDateOnly } from "@/lib/format/posted-date";
import { REPOST_EVENTS_KEPT, type GhostOfJob } from "@/lib/ghost/types";

/** The posted date of a job and how far to trust it. */
export interface PostedView {
  /** `jobs.posted_at`; null = no source gave one. */
  postedAt: Date | null;
  /** The source gave a day, not a time (stored as UTC midnight). */
  dateOnly: boolean;
  /** A relisting under a new link, from the stored ghost check; null = no evidence (or the check is off). */
  repost: PostedRepost | null;
  /**
   * `trusted`: at least one source's channel states the date itself (an ATS's publish date); `posted_at` is the earliest of all
   * sources, so this does not say the date came from that channel. `aggregator`: only aggregators, whose date may be a refresh.
   */
  trust: { kind: "trusted"; channelIds: string[] } | { kind: "aggregator" } | { kind: "none" };
}

export type PostedRepost =
  | {
      kind: "events";
      /** The day we first saw the newest new link (UTC midnight). */
      newSeen: Date;
      /** The earliest day an old link was first seen, among the kept relistings (UTC midnight). */
      oldestSeen: Date;
      /** Relistings kept in the evidence. */
      count: number;
      /** The evidence keeps only the latest relistings; at the cap there may have been more before. */
      capped: boolean;
      /** Days between the old and the new link of the newest relisting. */
      gapDays: number;
      /** The source's own "reposted" label when it has one too. */
      label: string | null;
    }
  | { kind: "label"; label: string };

export interface PostedViewInput {
  postedAt: Date | null;
  sources: ReadonlyArray<{ channelId: string }>;
  ghost: Pick<GhostOfJob, "reasons"> | null;
  /** The ghost job check is turned on (ui.yaml); off, a stored result is stale and ignored. */
  ghostOn: boolean;
  /** Channels that declare `trustedPostedAt`. */
  trustedChannels: ReadonlySet<string>;
}

const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

function repostOf(ghost: PostedViewInput["ghost"]): PostedRepost | null {
  if (ghost === null) return null;
  let label: string | null = null;
  for (const reason of ghost.reasons) {
    if (reason.code === "repost_label") label = reason.label;
  }
  for (const reason of ghost.reasons) {
    if (reason.code !== "reposted" || reason.events.length === 0) continue;
    const newest = reason.events.reduce((best, event) => (event.newSeen >= best.newSeen ? event : best));
    const oldest = reason.events.reduce((best, event) => (event.oldSeen < best ? event.oldSeen : best), newest.oldSeen);
    return {
      kind: "events",
      newSeen: dayStart(newest.newSeen),
      oldestSeen: dayStart(oldest),
      count: reason.events.length,
      capped: reason.events.length >= REPOST_EVENTS_KEPT,
      gapDays: newest.gapDays,
      label,
    };
  }
  return label === null ? null : { kind: "label", label };
}

export function buildPostedView(input: PostedViewInput): PostedView {
  const trustedIds = [...new Set(input.sources.map((source) => source.channelId).filter((id) => input.trustedChannels.has(id)))].sort();
  return {
    postedAt: input.postedAt,
    dateOnly: input.postedAt !== null && isDateOnly(input.postedAt),
    repost: input.ghostOn ? repostOf(input.ghost) : null,
    trust: trustedIds.length > 0 ? { kind: "trusted", channelIds: trustedIds } : input.sources.length > 0 ? { kind: "aggregator" } : { kind: "none" },
  };
}
