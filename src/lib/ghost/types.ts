import { z } from "zod";

/** The signals of the ghost job check (docs/ghost-jobs.md), in the order the pages list them. */
export const GHOST_REASONS = ["long_open", "repost_label", "reposted", "evergreen_wording", "thin_description"] as const;
export type GhostReasonCode = (typeof GHOST_REASONS)[number];

/** The reasons that are not about time or text length: a `likely` result needs at least one of them. */
export const NON_TIME_REASONS: readonly GhostReasonCode[] = ["repost_label", "reposted", "evergreen_wording"];

export const GHOST_LEVELS = ["none", "watch", "likely"] as const;
export type GhostLevel = (typeof GHOST_LEVELS)[number];

/** The `/jobs` filter (`@/lib/jobs/constants`): `all` = no filter, `only` = watch + likely, `hide` = without the likely ones. */
export { GHOST_FILTERS, type GhostFilter } from "@/lib/jobs/constants";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const points = z.number().int().min(0).max(10);
const channelId = z.string().min(1).max(100);

/** "Open for N days": since the trusted posted date of a source (`posted`) or since the job was first seen (`first_seen`). */
export const longOpenReasonSchema = z.strictObject({
  code: z.literal("long_open"),
  points,
  days: z.number().int().nonnegative(),
  since: day,
  from: z.enum(["posted", "first_seen"]),
  /** The source whose posted date it is (null for `first_seen`). */
  channelId: channelId.nullable(),
});

/** The source labelled the posting "reposted". */
export const repostLabelReasonSchema = z.strictObject({
  code: z.literal("repost_label"),
  points,
  channelId,
  /** The source's label as it was (at most 120 characters). */
  label: z.string().min(1).max(120),
});

/** One relisting: the same channel listed the job under a new id at least the minimum gap later. */
export const repostEventSchema = z.strictObject({ oldId: z.string().min(1).max(300), newId: z.string().min(1).max(300), oldSeen: day, newSeen: day, gapDays: z.number().int().nonnegative() });
export type RepostEvent = z.infer<typeof repostEventSchema>;

export const repostedReasonSchema = z.strictObject({
  code: z.literal("reposted"),
  points,
  channelId,
  events: z.array(repostEventSchema).min(1).max(10),
});

/** The JD says it is a talent pool or always open: a verbatim quote of `jobs.description` at `offset` (C7). */
export const evergreenReasonSchema = z.strictObject({
  code: z.literal("evergreen_wording"),
  points,
  patternId: z.string().min(1).max(64),
  quote: z.string().min(1),
  offset: z.number().int().nonnegative(),
});

/** A short JD or one without a duties section, from a source that keeps the full text. */
export const thinReasonSchema = z.strictObject({
  code: z.literal("thin_description"),
  points,
  words: z.number().int().nonnegative(),
  minWords: z.number().int().nonnegative(),
  /** Whether a duties section was found (in the JD's headings, or in the current AI breakdown when there is one); false for `none`. */
  hasResponsibilities: z.boolean(),
  /**
   * What decided `hasResponsibilities`: the current AI breakdown, the JD's duties headings, or nothing (`none`: no current breakdown
   * and `infer_from_headings` off; only a short JD is a reason then, for its length).
   */
  responsibilitiesFrom: z.enum(["headings", "breakdown", "none"]),
  channelId,
});

export const ghostReasonSchema = z.discriminatedUnion("code", [longOpenReasonSchema, repostLabelReasonSchema, repostedReasonSchema, evergreenReasonSchema, thinReasonSchema]);
export type GhostReason = z.infer<typeof ghostReasonSchema>;
export type GhostReasonOf<C extends GhostReasonCode> = Extract<GhostReason, { code: C }>;

export const ghostReasonListSchema = z.array(ghostReasonSchema);

export interface GhostResult {
  level: GhostLevel;
  /** The points of all reasons. */
  score: number;
  /** In `GHOST_REASONS` order. */
  reasons: GhostReason[];
  /** When the "open for long" points would next change (a tier is reached), so the job is checked again then; null = never. */
  recheckAt: Date | null;
}

/** A source posting of a job, as the check reads it. */
export interface GhostPosting {
  channelId: string;
  externalId: string;
  firstSeenAt: Date;
  locationLabel: string | null;
  /** The channel declares that one posting keeps one id (`stableExternalIds`). */
  stableIds: boolean;
  /** The source's "reposted" label (`repostLabel` of the channel), when it has one. */
  repostLabel: string | null;
}

/** What one job's check reads (C1: built from stored rows only). */
export interface GhostInput {
  jobId: number;
  status: "active" | "possibly_closed" | "closed";
  firstSeenAt: Date;
  /** The company is on ui.yaml `job_checks.ghost.trusted_companies`. */
  trustedCompany: boolean;
  /** The earliest posted date of a source whose channel declares `trustedPostedAt`; null when none has one. */
  trustedPostedAt: { at: Date; channelId: string } | null;
  description: string | null;
  /** The source the description comes from (the best-priority one), when its channel keeps the full text; null = not judged. */
  descriptionSource: { channelId: string } | null;
  postings: GhostPosting[];
  /** The number of duties in the AI breakdown of the current description; null when there is none. */
  breakdownResponsibilities: number | null;
}

/** A stored result as the pages read it. */
export interface GhostOfJob {
  level: GhostLevel;
  score: number;
  reasons: GhostReason[];
  checkedAt: Date;
  dismissedAt: Date | null;
  dismissedCodes: GhostReasonCode[] | null;
  /** The owner dismissed it and no new reason code came up since. */
  dismissed: boolean;
}

/** Whether a dismissal still holds: every current reason code was among those dismissed. */
export function isDismissActive(dismissedCodes: readonly string[] | null, reasons: ReadonlyArray<Pick<GhostReason, "code">>): boolean {
  if (dismissedCodes === null) return false;
  const known = new Set(dismissedCodes);
  return reasons.every((reason) => known.has(reason.code));
}
