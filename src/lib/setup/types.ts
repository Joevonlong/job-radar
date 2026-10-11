/**
 * What a setup step returns (Server Actions and `pnpm run setup` share it). Plain types: the browser imports them.
 * Never carries a secret value: environment variables appear as names and present / absent only.
 */
import type { FieldErrorKey as ProfileFieldErrorKey } from "@/lib/profile/draft";

import type { SetupStepId } from "./steps";

/** Errors of fields the wizard owns (the profile fields use the profile page's own messages). */
export const SETUP_ERROR_KEYS = [
  "required",
  "invalid",
  "invalidChoice",
  "timezone",
  "languageCode",
  "notInCatalog",
  "orderEmpty",
  "boardDuplicate",
  "boardInvalid",
  "needsParent",
  "consentRequired",
] as const;
export type SetupErrorKey = (typeof SETUP_ERROR_KEYS)[number];

export type SetupFieldError =
  | { path: string; ns: "profile"; key: ProfileFieldErrorKey; params?: Record<string, string | number> }
  | { path: string; ns: "setup"; key: SetupErrorKey; params?: Record<string, string | number> };

/** Problems of the whole step (not one field). */
export const SETUP_FORM_ERRORS = [
  /** The browser (or the answers file) sent something that is not this step's input. */
  "invalidPayload",
  /** Nothing was written. */
  "writeFailed",
  /** The profile file was written but its history snapshot was not (database down). */
  "snapshotFailed",
  /** me.yaml / preferences.yaml cannot be read: fix it on /me first. */
  "profileUnreadable",
  /** A config file the step writes cannot be read. */
  "configUnreadable",
  /** models.yaml cannot be read, so no model can be checked. */
  "catalogUnreadable",
  /** setup.yaml cannot be read or written (the doctor names the problem). */
  "setupUnreadable",
  /** The request could not be queued. */
  "databaseUnavailable",
] as const;
export type SetupFormError = (typeof SETUP_FORM_ERRORS)[number];

export type SetupStepResult =
  | { status: "saved"; step: SetupStepId }
  | { status: "skipped"; step: SetupStepId }
  | { status: "error"; step: SetupStepId; fieldErrors: SetupFieldError[]; formError: SetupFormError | null };

/** `useActionState` / transition state of the wizard's forms. */
export type SetupActionState = { status: "idle" } | (SetupStepResult & { nonce: number });

export const IDLE_SETUP_STATE: SetupActionState = { status: "idle" };

/** An environment variable the step needs: its name and whether it is set (never its value). */
export interface EnvPresence {
  name: string;
  present: boolean;
}

export function stepError(step: SetupStepId, formError: SetupFormError | null, fieldErrors: SetupFieldError[] = []): SetupStepResult {
  return { status: "error", step, fieldErrors, formError };
}
