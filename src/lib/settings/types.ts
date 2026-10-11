import type { SettingsFieldError, SettingsDraft } from "./draft";
import type { SettingsForm } from "./tabs";

/** Whole-form problems that are not tied to one field. */
export type SettingsFormErrorKey =
  /** The browser sent something that is not a settings draft. */
  | "invalidPayload"
  /** The file on disk cannot be read or no longer passes its schema: fix the YAML first. */
  | "unreadable"
  /** Nothing was written. */
  | "writeFailed"
  /** models.yaml cannot be read, so the models of ai.yaml cannot be checked. */
  | "catalogUnreadable"
  /** The save would change a protected key (an API host, a command, a credential path): those are edited by hand in the file. */
  | "protectedKeys"
  /** The file changed on disk after the form was opened; nothing was written, the form reloads with the saved values. */
  | "stale";

/** State of the save Server Action as seen by `useActionState`. */
export type SettingsActionState =
  | { status: "idle" }
  | { status: "saved"; tab: SettingsForm; /** Distinguishes two consecutive saves. */ nonce: number }
  | {
      status: "error";
      tab: SettingsForm;
      /** Hash of the file when the action ran; errors only apply while the file is unchanged. */
      baseHash: string;
      fieldErrors: SettingsFieldError[];
      formError: SettingsFormErrorKey | null;
    };

export const IDLE_SETTINGS_STATE: SettingsActionState = { status: "idle" };

/** What the browser sends to the save action. */
export interface SaveSettingsRequest {
  tab: SettingsForm;
  draft: SettingsDraft;
  /** Hash of the file text the form was opened on (`SettingsSection.hash`); required. */
  baseHash: string;
}

// ---------------------------------------------------------------- page data (server -> client)

export interface SettingsSection {
  tab: SettingsForm;
  /** Hash of the file text the section was rendered from. */
  hash: string;
  /** Form values, or null when the file cannot be loaded (see `loadError`). */
  draft: SettingsDraft | null;
  loadError: string | null;
  /** The file this tab saves to, for people (`data/config/schedule.yaml`); absent = the bare file name. */
  file?: string;
  /** AI tab: the models.yaml in use, for people (`config/models.yaml` or the user's override). */
  catalogFile?: string;
}
