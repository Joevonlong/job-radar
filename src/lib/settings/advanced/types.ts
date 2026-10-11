import type { TextIssue } from "@/lib/config/validate-text";
import type { DiffLine } from "@/lib/config/diff";

export type { TextIssue, DiffLine };

/** Which layer a file is read from (mirrors `ConfigLayer`, for the browser). */
export type AdvancedLayer = "user" | "default" | "missing";

/** One row of the file list. */
export interface AdvancedFileEntry {
  /** The name used in `?file=`: the file's name without `.yaml` (`sources`, not `channels`). */
  stem: string;
  /** `ai.yaml`. */
  file: string;
  /** `user` = copied into the user directory and owned by the user; `shipped` = read from the product defaults (a saved copy overrides it whole). */
  group: "user" | "shipped";
  layer: AdvancedLayer;
  /** A copy in the user directory replaces a shipped file (only `shipped` files can be overridden). */
  overridden: boolean;
  valid: boolean;
  /** First problem as one line (`path: reason`), when the file is not valid. */
  firstProblem: string | null;
  /** The file's `config_version` is below the code's (it is migrated in memory; `pnpm config:migrate --write` writes it). */
  versionBehind: boolean;
}

/** The text of one config file for the editor. Credentials of `sources.yaml`'s proxies are already masked. */
export interface AdvancedFileData {
  entry: AdvancedFileEntry;
  /** For people: `data/config/ai.yaml` or `config/ai.yaml`. */
  path: string;
  /** Hash of the file's real text and its layer: sent back with a save so a change made meanwhile is noticed. */
  hash: string;
  layer: AdvancedLayer;
  text: string;
  /** The shipped default's text (masked); null when there is none. */
  defaultText: string | null;
  /** `config_version` the code writes for this file. */
  codeVersion: number;
  maxBytes: number;
  /** Whether "restore default" has anything to do: the user file differs from / overrides the default. */
  canReset: boolean;
  /** The file's protected key patterns (`providers.*.command`): edited by hand in the file, not here. Empty when none. */
  protectedKeys: string[];
  /** `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` is set: the protected keys can be changed here too. */
  protectedUnlocked: boolean;
}

export type AdvancedLoad = { ok: true; data: AdvancedFileData } | { ok: false; reason: "unknown_file" | "unreadable" };

export interface AdvancedValidation {
  ok: boolean;
  issues: TextIssue[];
  warnings: TextIssue[];
}

/** Why a save or reset did not happen. `stale`: the file changed since the editor opened it (the latest is attached). */
export type AdvancedFailure =
  | { status: "invalid"; issues: TextIssue[] }
  | { status: "stale"; current: { text: string; hash: string; layer: AdvancedLayer } }
  | { status: "too_large" }
  | { status: "proxies_changed" }
  | { status: "needs_confirm" }
  /** The text changes a protected key (the live check reports which one; this is the write's own refusal). */
  | { status: "protected" }
  | { status: "failed" };

export type AdvancedSaveResult = { status: "saved"; hash: string; layer: AdvancedLayer; text: string; backup: boolean } | AdvancedFailure;
export type AdvancedResetResult = { status: "reset"; hash: string; layer: AdvancedLayer; text: string; backup: boolean } | AdvancedFailure;

/** The diff shown before a save: against what is saved, or against the product default. */
export type AdvancedPreviewAgainst = "saved" | "default";

export interface AdvancedPreview {
  lines: DiffLine[];
  /** Dotted key paths whose values differ; null when either text is not valid YAML. */
  paths: string[] | null;
  /** False = nothing differs ("no changes"). */
  changed: boolean;
  /** The file changed after the editor opened it (the latest text is attached): the diff would show the outside change as the user's own. */
  stale: { text: string; hash: string; layer: AdvancedLayer } | null;
}
