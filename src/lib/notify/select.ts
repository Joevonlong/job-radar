import type { PushCandidate } from "@/lib/db/repos/notifications";
import { isCompanyWatched } from "@/lib/companies/marks";

/**
 * Which jobs to push after a cycle. A pure function over plain data: the step loads
 * the candidates, the already-notified ids and the watched companies, this decides.
 */

export interface SelectionConfig {
  push_min_score: number;
  push_min_score_high_value: number;
  max_per_cycle: number;
}

/** Why a job was pushed (stored in the notification payload; `t1_t2` was renamed to `high_value`, old rows keep theirs). */
export type PushReason = "threshold" | "high_value" | "watched";

export interface PushItem {
  candidate: PushCandidate;
  /** The job's company is on the watch list (company flag or interests.yaml). */
  watched: boolean;
  /** Rank value used for ordering; null for a watched job that has no score yet. */
  rank: number | null;
  reason: PushReason;
}

export interface Selection {
  /** The jobs to send, best first, at most `max_per_cycle`. */
  selected: PushItem[];
  /** Eligible jobs cut by `max_per_cycle` (they stay on the dashboard). */
  overflow: PushItem[];
  /** Candidates that were not pushable, by reason. */
  skipped: { alreadyNotified: number; filteredOut: number; unscored: number; belowThreshold: number };
}

/** Sorts below every real rank value (those are >= 0). */
const UNSCORED_RANK = -1;

/**
 * A signal of a high-value category (an amount only when it is a high-pay signal: below the salary floor or of
 * another region it does not lower the threshold). Worked out by `listPushCandidates` with the current policy.
 */
export function hasHighSignal(candidate: PushCandidate): boolean {
  return candidate.highValue === true;
}

/** The score rule of the push (rule 5 below), also what "qualified" means in the cycle summary and on Today. */
export function reachesPushScore(rank: number, highSignal: boolean, config: Pick<SelectionConfig, "push_min_score" | "push_min_score_high_value">): boolean {
  return rank >= (highSignal ? config.push_min_score_high_value : config.push_min_score);
}

export function isWatched(candidate: PushCandidate, watchedKeys: ReadonlySet<string>): boolean {
  return isCompanyWatched({ watched: candidate.companyWatched, nameNorm: candidate.companyNameNorm }, watchedKeys);
}

/**
 * Rules, in order:
 * 1. already pushed (or cut by the cap in an earlier cycle) → never again;
 * 2. a score row that says `filtered_out` → never (hard filters are not a threshold);
 * 3. watched company → push, whatever the score (and even when it has no score yet);
 * 4. no score / no rank yet → not pushable;
 * 5. rank ≥ `push_min_score`, or ≥ `push_min_score_high_value` when a high-value signal exists.
 * Eligible jobs are ordered by rank, best first (unscored watched jobs last), then oldest first, then id;
 * the first `max_per_cycle` are selected.
 */
export function selectForPush(
  candidates: readonly PushCandidate[],
  options: { config: SelectionConfig; watchedKeys: ReadonlySet<string>; alreadyNotified: ReadonlySet<number> },
): Selection {
  const { config, watchedKeys, alreadyNotified } = options;
  const skipped = { alreadyNotified: 0, filteredOut: 0, unscored: 0, belowThreshold: 0 };
  const eligible: PushItem[] = [];

  for (const candidate of candidates) {
    if (alreadyNotified.has(candidate.jobId)) {
      skipped.alreadyNotified += 1;
      continue;
    }
    if (candidate.score?.filterResult === "filtered_out") {
      skipped.filteredOut += 1;
      continue;
    }
    const watched = isWatched(candidate, watchedKeys);
    const rank = candidate.score?.rankValue ?? null;
    if (watched) {
      eligible.push({ candidate, watched, rank, reason: "watched" });
      continue;
    }
    if (rank === null) {
      skipped.unscored += 1;
      continue;
    }
    const highSignal = hasHighSignal(candidate);
    if (!reachesPushScore(rank, highSignal, config)) {
      skipped.belowThreshold += 1;
      continue;
    }
    eligible.push({ candidate, watched, rank, reason: highSignal && rank < config.push_min_score ? "high_value" : "threshold" });
  }

  eligible.sort(
    (a, b) =>
      (b.rank ?? UNSCORED_RANK) - (a.rank ?? UNSCORED_RANK) ||
      a.candidate.firstSeenAt.getTime() - b.candidate.firstSeenAt.getTime() ||
      a.candidate.jobId - b.candidate.jobId,
  );
  return { selected: eligible.slice(0, config.max_per_cycle), overflow: eligible.slice(config.max_per_cycle), skipped };
}
