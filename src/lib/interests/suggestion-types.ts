/** State of the suggestion Server Actions as the client sees it. No server imports: shared with the components. */

export interface SuggestionRecompute {
  /** The ranking was recomputed (bonus and rank value of the scored jobs). */
  reconciled: boolean;
  checked: number;
  updated: number;
  /** The next cycle scans the job descriptions again for the new vocabulary. */
  rescanPending: boolean;
  /** preferences.yaml changed: the scores are marked stale and re-scored. */
  rescorePending: boolean;
}

export type SuggestionError =
  | "invalidPayload"
  | "notFound"
  | "alreadyDecided"
  | "unreadableSuggestion"
  | "unreadable"
  | "writeFailed"
  /** The word's category was deleted since the suggestion was made. */
  | "categoryMissing"
  | "databaseUnavailable";

export type SuggestionActionState =
  | { status: "idle" }
  | { status: "approved"; id: number; nonce: number; change: "added" | "alreadyPresent"; recompute: SuggestionRecompute }
  | { status: "rejected"; id: number; nonce: number }
  | { status: "error"; id: number; nonce: number; error: SuggestionError };

export const IDLE_SUGGESTION_STATE: SuggestionActionState = { status: "idle" };

export type SuggestRunState =
  | { status: "idle" }
  | { status: "queued"; request: number; existing: boolean; nonce: number }
  | { status: "error"; error: "databaseUnavailable"; nonce: number };
