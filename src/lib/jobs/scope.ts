import { ARCHIVE_REASONS, type ArchiveReason, type JobScope } from "./constants";

/**
 * Explicit scope intersects status filters. Absent scope keeps the legacy rule for old links, saved views and
 * callers without a scope: selecting a status includes all jobs; otherwise only current jobs are shown.
 */
export function resolveJobScope(scope: JobScope | null | undefined, statuses: readonly string[] | null | undefined): JobScope {
  return scope ?? (statuses?.length ? "all" : "current");
}

export function isArchivedReason(reason: string | null | undefined): reason is ArchiveReason {
  return ARCHIVE_REASONS.some((archived) => archived === reason);
}
