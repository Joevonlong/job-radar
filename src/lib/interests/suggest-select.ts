import type { SuggestConfig } from "@/lib/config";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";
import type { SuggestionSourceJob } from "@/lib/db/repos/interest-suggestions";

export interface SuggestionCandidates {
  /** Jobs the user liked, strongest status first, then newest. */
  positive: SuggestionSourceJob[];
  /** Jobs the user ignored, newest first (the contrast). */
  ignored: SuggestionSourceJob[];
}

/** Later in the pipeline = stronger interest: offer beats interviewing beats applied beats preparing beats interested. */
function strength(job: SuggestionSourceJob): number {
  return APPLICATION_STATUSES.indexOf(job.applicationStatus);
}

/**
 * Which jobs the AI reads: the jobs of `rows` in a positive status, strongest status first and newest
 * first within a status, at most `max_positive_jobs`; the jobs in an ignored status, newest first, at most
 * `max_ignored_jobs`. A job is in one group only. `rows` may hold both groups (the caller fetched by status and
 * window); a status that is in neither group is ignored.
 */
export function selectCandidates(
  rows: readonly SuggestionSourceJob[],
  config: Pick<SuggestConfig, "positive_statuses" | "ignored_statuses" | "max_positive_jobs" | "max_ignored_jobs">,
): SuggestionCandidates {
  const seen = new Set<number>();
  const unique = rows.filter((row) => {
    if (seen.has(row.jobId)) return false;
    seen.add(row.jobId);
    return true;
  });
  const newestFirst = (a: SuggestionSourceJob, b: SuggestionSourceJob): number => b.statusChangedAt.getTime() - a.statusChangedAt.getTime() || b.jobId - a.jobId;
  const positive = unique
    .filter((row) => config.positive_statuses.includes(row.applicationStatus))
    .sort((a, b) => strength(b) - strength(a) || newestFirst(a, b))
    .slice(0, config.max_positive_jobs);
  const ignored = unique
    .filter((row) => config.ignored_statuses.includes(row.applicationStatus))
    .sort(newestFirst)
    .slice(0, config.max_ignored_jobs);
  return { positive, ignored };
}
