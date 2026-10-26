import type { DiffLine } from "@/lib/config/diff";
import type { ProfileName } from "@/lib/config/registry";

import type { FieldError } from "./draft";

export type { ProfileName };

/** Whole-form problems that are not tied to one field. */
export type FormErrorKey =
  /** The browser sent something that is not a profile draft. */
  | "invalidPayload"
  /** Nothing was written. */
  | "writeFailed"
  | "frozen"
  /** The file was written but the history/snapshot step failed (database down?). */
  | "snapshotFailed"
  | "snapshotNotFound"
  /** The stored snapshot no longer passes today's schema. */
  | "snapshotInvalid"
  /** The file changed on disk after the form was opened; nothing was written, the form reloads with the saved values. */
  | "stale";

/** State of a profile Server Action as seen by `useActionState`. */
export type ProfileActionState =
  | { status: "idle" }
  | { status: "saved"; kind: ProfileName; /** Distinguishes two consecutive saves. */ nonce: number }
  | {
      status: "error";
      kind: ProfileName;
      /** Hash of the file content when the action ran; errors only apply while the file is unchanged. */
      baseHash: string;
      fieldErrors: FieldError[];
      formError: FormErrorKey | null;
    };

export const IDLE_ACTION_STATE: ProfileActionState = { status: "idle" };

// ---------------------------------------------------------------- page data (server -> client)

export type { DiffLine };

export interface HistoryEntry {
  id: number;
  /** ISO timestamp of the last save of this exact content. */
  savedAt: string;
  /** The file on disk currently has exactly this content. */
  current: boolean;
  /** Changes relative to the next older entry; null for the oldest recorded version. */
  diff: DiffLine[] | null;
}

export interface ProfileSection<D> {
  kind: ProfileName;
  /** Hash of the file content the section was rendered from. */
  hash: string;
  /** Form values, or null when the file cannot be loaded (see `loadError`). */
  draft: D | null;
  loadError: string | null;
  history: HistoryEntry[];
}
