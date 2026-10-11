import type { Contract, GermanLevel, JobLanguage, JobLocation, JobSalary } from "@/lib/domain/types";

import type { ApplicationStatus } from "../repos/applications";
import type { FavoriteState } from "../repos/favorites";
import type { Job, JobStatus } from "../repos/jobs";
import type { ClosedReason } from "@/lib/jobs/closure";
import type { VisaKind } from "@/lib/visa/types";
import type { LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";

// Vocabulary of the `jobs` table is owned by the pipeline (`@/lib/domain/types`, `../repos/jobs`); the
// dashboard re-uses it. Only the pieces below are dashboard-specific.
export type { Contract, GermanLevel, JobLanguage, JobLocation, JobSalary, JobStatus };
export type Workplace = Job["workplace"];
/** A signal category id (`signals.tier`: user-defined categories, was the enum T1-T4 / tag). */
export type SignalTier = string;

export interface JobSourceRef {
  channelId: string;
  family: string;
  /** Link to the posting on that source. */
  url: string | null;
  /** Direct apply link when the channel gave one (`job_sources.apply_url`); preferred over `url` for "apply". */
  applyUrl: string | null;
  /** Where this posting says the job is; null when the posting names no location. */
  locationLabel?: string | null;
  /** Apply-link priority: lower wins. */
  priority: number;
}

export interface JobSignal {
  id: number;
  tier: SignalTier;
  kind: string;
  value: unknown;
  /** C7: verbatim JD quote, or the source field's own text when `quoteSource` is `structured`. */
  quote: string;
  quoteOffset: number | null;
  /** `structured`: the quote is a source's salary field, not JD text (the UI labels it as the source field). */
  quoteSource: "description" | "structured";
  /** Found by the vocabulary rules or by the AI review. */
  extractor: "rule" | "ai";
}

/** The newest `scores` row of a job (M2 fills these; before that nothing is ranked). */
export interface JobRank {
  rankValue: number | null;
  score: number | null;
  signalBonus: number;
  filterResult: "passed" | "filtered_out";
  filterReasons: string[];
  stale: boolean;
}

/** A job as the Today and Jobs lists show it. */
export interface JobCard {
  id: number;
  title: string;
  companyId: number;
  companyName: string;
  locations: JobLocation[];
  workplace: Workplace;
  contract: Contract;
  /** The posting comes from a recruiter / staffing agency (pipeline flag). */
  isAgency: boolean;
  germanLevelRequired: GermanLevel;
  /** The status the job shows: the automatic status with the user's own closed / open judgement on top. */
  status: JobStatus;
  /** Why it shows as (possibly) closed; null when open. */
  closedReason: ClosedReason | null;
  /** What the last recheck of its posting found (null before any). */
  linkCheck: LinkCheckEvidence | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** `salary_json` is present. When false the posting does not state a salary (C3). */
  salaryDisclosed: boolean;
  /** The parsed salary; null when none is stated, or when the stored JSON is not readable. */
  salary: JobSalary | null;
  /** Skill names the pipeline found in title + description (`jobs.skills`, canonical names of pipeline.yaml `skills`); empty when none was found. */
  skills: string[];
  /** One entry per source posting, best apply link first. */
  sources: JobSourceRef[];
  /** Application status; null when the job has no application yet (shown as `new`). */
  applicationStatus: ApplicationStatus | null;
  /** The user's star on this job, independent of the application status; null when not starred. */
  favorite: FavoriteState | null;
  rank: JobRank | null;
  /**
   * The AI's one-line summary of the posting (newest score row): language -> text, and the language the AI wrote
   * the reasons in; null when the job has no summary.
   */
  summary: { texts: Readonly<Record<string, string>>; outputLang: string | null } | null;
  signals: JobSignal[];
  /** AI traps found in the posting (`trap_scans` counts); null before the first trap scan. */
  traps?: { traps: number; suspicious: number } | null;
  /** What the JD says about visa sponsorship, when it says something clear (`job_visa`: offered / not_offered); null otherwise or before the check. */
  visa?: { status: "offered" | "not_offered"; kind: VisaKind } | null;
  /** The user has looked at the job (opened it, its posting, or acted on its row); unseen rows are bold with a dot. */
  seen: boolean;
}
