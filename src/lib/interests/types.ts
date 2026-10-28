import type { VocabularyFieldError } from "./vocabulary-draft";
import type { ConfigWriteErrorKey } from "@/lib/config/errors";

export type InterestsSection = "vocabulary" | "views" | "watched";

/** Whole-form problems that are not tied to one field. */
export type InterestsFormError =
  | ConfigWriteErrorKey
  /** The browser sent something that is not a valid request. */
  | "invalidPayload"
  /** interests.yaml cannot be read or does not pass the schema. */
  | "unreadable"
  /** Nothing was written. */
  | "writeFailed"
  /** The view name is empty or too long. */
  | "invalidName"
  /** A view with this name exists (overwrite to replace its filters). */
  | "nameTaken"
  /** Nothing to save: no filter is set. */
  | "noFilters"
  | "viewNotFound"
  | "alreadyWatched"
  | "watchedNotFound"
  /** A saved signal category is missing from the draft (the page is out of date). */
  | "categoryMissing"
  /** The draft retires a category the file does not have. */
  | "unknownRetired";

/** What happened to the ranking after a vocabulary save (no AI involved). */
export interface RecomputeOutcome {
  /** Bonuses and rank values were brought in line with the new weights (false: the database could not be reached). */
  reconciled: boolean;
  /** `scores` rows looked at / changed. */
  checked: number;
  updated: number;
  /** Words or patterns changed: the runner re-scans the job descriptions in its next cycle (signals step, no extra request needed). */
  rescanPending: boolean;
  /** The AI part changed (definitions, AI categories, `ai_confirm_only`): jobs on the shelf are reviewed again, within the per-cycle limit. */
  reviewPending?: boolean;
  /** How many jobs that review covers and in about how many cycles (null: not estimated). */
  reviewEstimate?: { jobs: number; rounds: number | null } | null;
}

/** State of the interests Server Actions as seen by `useActionState` / transitions. */
export type InterestsActionState =
  | { status: "idle" }
  | { status: "saved"; section: InterestsSection; nonce: number; /** Id of the view that was saved. */ id?: string; recompute?: RecomputeOutcome }
  | { status: "error"; section: InterestsSection; nonce: number; formError: InterestsFormError | null; fieldErrors: VocabularyFieldError[] };

export const IDLE_INTERESTS_STATE: InterestsActionState = { status: "idle" };

/** One view as the /interests page and the Today tabs show it. */
export interface WatchedCompanyView {
  /** The name as written in interests.yaml. */
  name: string;
  /** Company of the database it matches, and its jobs; null while no such company was collected yet. */
  match: { name: string; jobCount: number } | null;
  /** An enabled ATS board carries this company (its jobs are collected in every city); false = only the city queries find it. */
  hasBoard: boolean;
}

/** Longest autocomplete list. */
export const COMPANY_SUGGESTION_LIMIT = 8;
