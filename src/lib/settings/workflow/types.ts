import type { SettingsErrorKey } from "../draft";

/** The fields of the workflow panel, for error messages. */
export type WorkflowField = "interestedDays" | "appliedDays" | "hiddenStatuses" | "hiddenWorkplaces" | "hiddenContracts";

/** What the panel edits: the hidden lists and the two timeouts (as text, like every form value). */
export interface WorkflowDraft {
  hiddenStatuses: string[];
  hiddenWorkplaces: string[];
  hiddenContracts: string[];
  interestedDays: string;
  appliedDays: string;
}

export interface WorkflowFieldError {
  field: WorkflowField;
  key: SettingsErrorKey;
  params?: Record<string, string | number>;
}

/** Whole-panel problems. `partial`: the first file was written and the second was not (`failedFile` says which one is still old). */
export type WorkflowFormError = "invalidPayload" | "unreadable" | "writeFailed" | "partial";

export type WorkflowFile = "ui" | "notify";

export type WorkflowActionState =
  | { status: "idle" }
  | { status: "saved"; nonce: number }
  | { status: "error"; formError: WorkflowFormError | null; failedFile: WorkflowFile | null; fieldErrors: WorkflowFieldError[]; /** Hashes of both files when the action ran. */ baseHash: string };

export const IDLE_WORKFLOW_STATE: WorkflowActionState = { status: "idle" };

/** Data of the workflow panel (server -> client). */
export interface WorkflowView {
  /** Hash of both files' text: the panel remounts (drops its edits) when a save or an outside change moves it. */
  hash: string;
  draft: WorkflowDraft | null;
  /** The file that cannot be read, with the reason (one line); null when both load. */
  loadError: { file: WorkflowFile; message: string } | null;
  /** Applications per status (null = the database cannot be reached). */
  counts: Partial<Record<string, number>> | null;
  /** The files as people read them (`data/config/ui.yaml`). */
  files: { ui: string; notify: string };
}
