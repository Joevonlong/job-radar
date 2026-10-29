import type { Contract, GermanLevel, JobRank, JobStatus, SignalTier, Workplace } from "@/lib/db/queries/types";
import type { SignalCategoryKind } from "@/lib/config/schemas/interests";
import type { SignalColor } from "@/lib/signals/palette";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import type { ClosedReason } from "@/lib/jobs/closure";
import type { ClosedEvidence } from "./status-chip";
import type { GhostMarkValue } from "./ghost-mark";
import type { VisaBadgeValue } from "./visa-badge";

export interface JobListSignal {
  /** Category id. */
  tier: SignalTier;
  kind: string;
  value: unknown;
  /** The category as the row draws it: its kind, name in the page language, icon, colour and short code. */
  category: { kind: SignalCategoryKind; label: string; icon: string | null; color: SignalColor; code: string | null };
  /** An amount below the salary floor: shown muted, no bonus. */
  belowFloor?: boolean;
  /** An amount that is possibly another region's pay: shown muted with a note. */
  otherRegion?: boolean;
}

/** A job as the list components render it: plain serializable data, times already formatted on the server. */
export interface JobListItem {
  id: number;
  title: string;
  companyName: string;
  /** City (or the location text when there is no city), at most a few. */
  locations: string[];
  /** How many more places the posting has that `locations` leaves out ("+N"). */
  moreLocations?: number;
  workplace: Workplace;
  contract: Contract;
  isAgency: boolean;
  germanLevelRequired: GermanLevel;
  jobStatus: JobStatus;
  salaryDisclosed: boolean;
  /** The stated compensation as one annual range ("€85–105k"), from the normalized fields; null when there is none or it is under review. */
  salaryText: string | null;
  /** Stated salary as numbers for the mini axis (EUR a year); null = not stated, under review, or not convertible to EUR. */
  salaryMin?: number | null;
  salaryMax?: number | null;
  /** The stated amount may be another region's pay: drawn hatched, no percentile. */
  salaryOtherRegion?: boolean;
  /** The EUR range is converted (a monthly rate, another currency): written "≈ €86k" like every other place this salary appears (`isApproxAnnual`). */
  salaryApprox?: boolean;
  /** The figure in the posting's own currency ("$140–170k"); null when it is EUR. */
  salaryFigure?: string | null;
  /** "Pays more than N% of the disclosed jobs" (0-100), from this month's stated salaries; null = nothing to compare with. */
  salaryPercentile?: number | null;
  /** Skill names the pipeline found in the posting (`jobs.skills`); empty = none listed (shown as "—", not 0/0). */
  skills?: string[];
  /** The ones of `skills` that me.yaml also names (case, spacing and pipeline.yaml aliases ignored). */
  skillHits?: string[];
  /** Hours since the job was first seen. */
  firstSeenHours?: number;
  /** Source families in apply-priority order, no duplicates. */
  families: string[];
  applicationStatus: ApplicationStatus | null;
  /** The user's star, independent of `applicationStatus`. */
  favorite?: boolean;
  /** The favorites page only: the star's note, "3 days ago" for when it was starred and the absolute time for the tooltip. */
  favoriteNote?: string | null;
  favoritedLabel?: string;
  favoritedTitle?: string;
  rank: JobRank | null;
  /** The salary floor the hard filter judged this job with; only read for a job removed for its salary, null otherwise or when unknown. */
  filterFloorEur?: number | null;
  /** Signals of the active categories, in category order (retired categories are left out). */
  signals: JobListSignal[];
  /** EUR per year a stated amount needs to count as a high-pay signal (tooltip of a muted badge); null = none. */
  amountMinAnnualEur?: number | null;
  /** The base currency `amountMinAnnualEur` is in. */
  amountCurrency?: string;
  /** The AI one-line summary in the UI language (the other language when only that exists); null before the job is scored. */
  summary?: string | null;
  /** AI traps in the posting (severity `trap`); 0 / absent = none (or traps.yaml is off). Shown as the first badge. */
  trapCount?: number;
  /** What the JD says about visa sponsorship when it is clear; only set when the badge shows (`visaVisible`). */
  visa?: VisaBadgeValue;
  /** The ghost job mark under the score (watch / likely, not dismissed); only set while ui.yaml turns the check on. */
  ghost?: GhostMarkValue;
  /** First seen after the user's last visit: only draws the "new since your last visit" divider, not the row style. */
  isNew?: boolean;
  /** Why the job shows as (possibly) closed; null / absent when open. */
  closedReason?: ClosedReason | null;
  /** What the last recheck of its posting found (the tag's tooltip). */
  closedEvidence?: ClosedEvidence | null;
  /** Source-observed relist inside the configured badge window; dates formatted on the server. */
  relisted?: { relative: string; firstSeen: string; count: number };
  /** The user has opened it, its posting, or acted on its row. Absent = seen (lists built before the seen state). */
  seen?: boolean;
  /** "3 hours ago" for the posting time, or "seen 3 hours ago" when the source gave none. */
  timeLabel: string;
  /** Absolute time for the tooltip. */
  timeTitle: string;
}
