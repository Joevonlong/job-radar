import type { ApplicationStatus } from "@/lib/db/repos/applications";

import { DEFAULT_APPLICATION_STATUS } from "./constants";

export type StatusTone = "muted" | "accent" | "primary" | "warning" | "success" | "destructive";

/** Chip colour per application status (from the mockup). */
export const STATUS_TONE: Record<ApplicationStatus, StatusTone> = {
  new: "muted",
  interested: "accent",
  preparing: "accent",
  applied: "primary",
  interviewing: "warning",
  offer: "success",
  rejected: "destructive",
  withdrawn: "muted",
  archived: "muted",
};

export function effectiveStatus(status: ApplicationStatus | null): ApplicationStatus {
  return status ?? DEFAULT_APPLICATION_STATUS;
}

/**
 * `s` on a list row: toggles interested. `new` becomes `interested`, `interested` goes back to `new`;
 * every later pipeline state is left alone (null = nothing to do).
 */
export function statusAfterInterestKey(current: ApplicationStatus | null): ApplicationStatus | null {
  const status = effectiveStatus(current);
  if (status === "new") return "interested";
  if (status === "interested") return "new";
  return null;
}

/**
 * `x` on a list row: ignore = `archived`; pressing it on an ignored job restores `new`. A job that
 * is further in the application flow (preparing, applied, interviewing, offer, or already ended) is
 * left alone (null): ignoring it would silently pull it off the board.
 */
export function statusAfterIgnoreKey(current: ApplicationStatus | null): ApplicationStatus | null {
  const status = effectiveStatus(current);
  if (status === "archived") return "new";
  if (status === "new" || status === "interested") return "archived";
  return null;
}
