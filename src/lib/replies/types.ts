/** Vocabulary of the Gmail replies. Plain types: the browser bundle imports them too. */
import type { ReplyCategory } from "@/lib/config/schemas/replies";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

export { REPLY_CATEGORIES, type ReplyCategory } from "@/lib/config/schemas/replies";

export type ReplyMatch = "matched" | "ambiguous" | "unmatched";
export type ReplyState = "pending" | "applied" | "dismissed" | "reverted" | "superseded" | "info";

/** A category a user can pick for a reply. */
export const PICKABLE_CATEGORIES = ["interview_invite", "rejection", "offer", "info_request", "acknowledgement", "other"] as const satisfies readonly ReplyCategory[];

export type NextActionKind = "interview" | "send_materials";

/**
 * What a reply suggests. Serializable (it is stored as JSON and sent to the browser).
 * - `status`: move the application `from` → `to`.
 * - `next_action`: set the next step; `previous` is what it was once the suggestion has been carried out, for the undo.
 * - `mismatch`: nothing to do, and the match looks wrong.
 * - `none`: only a record.
 */
export type ReplySuggestion =
  | { kind: "status"; from: ApplicationStatus; to: ApplicationStatus }
  | {
      kind: "next_action";
      from: ApplicationStatus;
      action: NextActionKind;
      /** `YYYY-MM-DD`; null when the date is left for the user to fill in. */
      due: string | null;
      previous?: { nextAction: string | null; nextActionAt: string | null };
    }
  | { kind: "mismatch"; from: ApplicationStatus }
  | { kind: "none" };

/** One application a reply might belong to, with the evidence for it. */
export interface ReplyCandidateScore {
  applicationId: number;
  jobId: number;
  score: number;
  /** Which evidence added to the score (`thread`, `ats`, `company`, `domain`, `title`). */
  hits: string[];
}

/** An application as the matching sees it. */
export interface MatchCandidate {
  applicationId: number;
  jobId: number;
  status: ApplicationStatus;
  companyName: string;
  aliases: readonly string[];
  atsToken: string | null;
  title: string;
  /** Host names of the job's source and apply links, and the company's own website. */
  hosts: readonly string[];
  /** The application's creation or first event, whichever is earlier. */
  since: Date;
}

/** An earlier reply the user confirmed, by thread (a later mail of the thread may follow it). */
export interface ConfirmedThread {
  threadId: string;
  senderDomain: string;
  applicationId: number;
}
