import { z } from "zod";

import { nonEmptyString, positiveInt } from "./common";

/** What a reply can be. `unclassified` is the outcome when the rules cannot decide, so it has no patterns of its own. */
export const REPLY_CATEGORIES = ["interview_invite", "rejection", "offer", "info_request", "acknowledgement", "other", "unclassified"] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

const STATUSES = ["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] as const;
/** Terminal statuses are never moved by a suggestion. */
export const REPLY_TERMINAL_STATUSES = ["rejected", "withdrawn", "archived"] as const;

const hostName = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a lower-case domain name");

const compiles = (source: string): boolean => {
  try {
    new RegExp(source, "iu");
    return true;
  } catch {
    return false;
  }
};
const regexSource = nonEmptyString.refine(compiles, "must be a valid regular expression");

/** The patterns of one category in one language: a hit in `subject` or `body` is strong unless `exclude` hits subject or body. */
const languagePatterns = z.strictObject({
  subject: z.array(regexSource).default([]),
  body: z.array(regexSource).default([]),
  exclude: z.array(regexSource).default([]),
});
const categoryPatterns = z.record(z.string().regex(/^[a-z]{2}$/, "must be a two-letter language code"), languagePatterns);

const notTerminal = (list: readonly string[]): boolean => !list.some((status) => (REPLY_TERMINAL_STATUSES as readonly string[]).includes(status));
const fromStatuses = z.array(z.enum(STATUSES)).min(1).refine(notTerminal, "terminal statuses are never moved by a suggestion");

const transition = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status"), from: fromStatuses, to: z.enum(STATUSES) }),
  /** Sets the application's next step (the text comes from the messages); `due_days` from the day the mail arrived, none = no date. */
  z.strictObject({ kind: z.literal("next_action"), from: fromStatuses, action: z.enum(["interview", "send_materials"]), due_days: positiveInt.optional() }),
  /** Changes nothing, and tells the user the match looks wrong. */
  z.strictObject({ kind: z.literal("mismatch"), from: fromStatuses }),
]);

/**
 * config/replies.yaml: reads the job-reply emails of one Gmail label with rules, matches them to applications and suggests a status
 * change that the user confirms. No AI is involved and nothing is ever applied on its own, so the file has no such key on purpose.
 */
export const repliesSchema = z.strictObject({
  config_version: z.literal(1).optional(),
  /** Off by default: while off the mailbox is not opened. */
  enabled: z.boolean(),
  /** The one Gmail label (= IMAP mailbox) that is read, read-only. */
  label: nonEmptyString,
  lookback_days: positiveInt,
  max_messages_per_cycle: positiveInt,
  /** How much of the visible body the patterns and the company-name check read. */
  body_scan_chars: positiveInt,
  categories: z.strictObject({
    interview_invite: categoryPatterns,
    rejection: categoryPatterns,
    offer: categoryPatterns,
    info_request: categoryPatterns,
    acknowledgement: categoryPatterns,
    other: categoryPatterns,
  }),
  match: z.strictObject({
    /** Statuses a reply can match. `interested` only ever matches an `acknowledgement`. */
    candidate_statuses: z.array(z.enum(STATUSES)).min(1).refine(notTerminal, "terminal statuses cannot be matched"),
    weights: z.strictObject({
      thread: z.number().nonnegative(),
      ats: z.number().nonnegative(),
      company: z.number().nonnegative(),
      domain: z.number().nonnegative(),
      title: z.number().nonnegative(),
    }),
    /** A match needs at least this score ... */
    min_score: z.number().positive(),
    /** ... and this lead over the second candidate; anything less is left to the user. */
    min_margin: z.number().nonnegative(),
    /** Candidates kept for the picker of an ambiguous reply. */
    max_candidates: positiveInt,
    /** Company names and tokens shorter than this are not looked for in the text (too many accidental hits). */
    min_company_chars: positiveInt,
    /** Title words shorter than this do not count in the title overlap. */
    min_title_word_chars: positiveInt,
    /** Applicant-tracking systems that send on behalf of many companies: never taken as the company's own domain. */
    ats_sender_domains: z.array(hostName),
    /** Free-mail and job-board domains: never taken as the company's own domain. */
    generic_domains: z.array(hostName),
    /** Subjects that many companies share (whole subject, case-insensitive): a Gmail thread with one of them proves nothing. */
    generic_subjects: z.array(regexSource),
  }),
  transitions: z.strictObject({
    interview_invite: z.array(transition),
    rejection: z.array(transition),
    offer: z.array(transition),
    info_request: z.array(transition),
    acknowledgement: z.array(transition),
  }),
  storage: z.strictObject({
    subject_max_chars: positiveInt,
    quote_max_chars: positiveInt,
    /** Decided replies keep only their category and link after this many days. */
    decided_retention_days: positiveInt,
  }),
  panel: z.strictObject({
    /** Confirmed replies keep an Undo in the /pipeline panel for this many days. */
    undo_days: positiveInt,
  }),
  doctor: z.strictObject({
    /** `pnpm run doctor` warns about replies waiting longer than this. */
    pending_warn_days: positiveInt,
  }),
});
export type RepliesConfig = z.infer<typeof repliesSchema>;
export type ReplyTransition = z.infer<typeof transition>;
