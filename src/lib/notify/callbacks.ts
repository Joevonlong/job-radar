import type { ApplicationStatus } from "@/lib/db/repos/applications";

/**
 * Inline-button callback data: `a:<jobId>:<action>` (≤ 64 bytes, Telegram's limit). Everything that
 * arrives is validated here before it touches the database; anything else is dropped.
 */

/** Buttons that move the application status (they remove the keyboard). */
export type StatusAction = "interested" | "ignore" | "resume";
/** The star buttons: they set the favorite flag only and leave the keyboard in place. */
export type FavoriteAction = "favorite" | "unfavorite";
export type JobAction = StatusAction | FavoriteAction;

/** `i` / `x` / `r` are the codes of messages already sent: they never change. `f` / `u` were added with the favorites. */
const ACTION_CODES = { i: "interested", x: "ignore", r: "resume", f: "favorite", u: "unfavorite" } as const satisfies Record<string, JobAction>;
const CODE_OF: Record<JobAction, keyof typeof ACTION_CODES> = { interested: "i", ignore: "x", resume: "r", favorite: "f", unfavorite: "u" };

const CALLBACK_PATTERN = /^a:([1-9]\d{0,14}):([ixrfu])$/;

export function isFavoriteAction(action: JobAction): action is FavoriteAction {
  return action === "favorite" || action === "unfavorite";
}

export function encodeCallback(jobId: number, action: JobAction): string {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new RangeError("jobId must be a positive safe integer");
  return `a:${jobId}:${CODE_OF[action]}`;
}

export function decodeCallback(data: string): { jobId: number; action: JobAction } | null {
  const match = CALLBACK_PATTERN.exec(data);
  if (!match) return null;
  const jobId = Number(match[1]);
  const code = match[2] as keyof typeof ACTION_CODES;
  return Number.isSafeInteger(jobId) ? { jobId, action: ACTION_CODES[code] } : null;
}

export interface ActionRule {
  /** Status the application moves to. */
  to: ApplicationStatus;
  /** Current statuses the button may move from: a press never undoes progress ("applied", "interviewing", ...). */
  allowFrom: readonly ApplicationStatus[];
  /** Line appended to the message once marked: a `telegram.callback.*` message. */
  marked: "callback.markedInterested" | "callback.markedIgnore" | "callback.markedResume";
}

/**
 * `ignore` maps to `archived` (the application status machine has no separate "ignored"); `resume`
 * marks the job `preparing` — exporting the JD for resume-kit is a separate hand-off.
 */
export const ACTION_RULES: Record<StatusAction, ActionRule> = {
  interested: { to: "interested", allowFrom: ["new", "archived"], marked: "callback.markedInterested" },
  ignore: { to: "archived", allowFrom: ["new", "interested", "preparing"], marked: "callback.markedIgnore" },
  resume: { to: "preparing", allowFrom: ["new", "interested", "archived"], marked: "callback.markedResume" },
};
