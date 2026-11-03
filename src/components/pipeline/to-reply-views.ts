import { getFormatter } from "next-intl/server";

import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { listPendingReplies, listRecentlyConfirmedReplies, listReplyLinkOptions, type ReplyListRow } from "@/lib/db/repos/replies";
import type { ReplyCategory, ReplyMatch, ReplySuggestion } from "@/lib/replies/types";

const DAY_MS = 86_400_000;

/** One reply as the panel renders it: plain data, dates formatted on the server. */
export interface ReplyView {
  id: number;
  subject: string | null;
  quote: string | null;
  senderDomain: string;
  receivedLabel: string;
  suspiciousInstruction: boolean;
  category: ReplyCategory;
  match: ReplyMatch;
  jobId: number | null;
  company: string | null;
  title: string | null;
  /** The applications the matching could not tell apart. */
  candidateJobIds: number[];
  suggestion: ReplySuggestion;
}

export interface ReplyLinkView {
  jobId: number;
  company: string;
  title: string;
}

export interface RepliesPanelData {
  pending: ReplyView[];
  recent: ReplyView[];
  links: ReplyLinkView[];
}

/** The panel's data; null when there is nothing to show (always so while the feature is off and has never read a mail). */
export async function loadRepliesPanel(options: { now: Date; timezone: string }): Promise<RepliesPanelData | null> {
  const db = getDb();
  const config = loadConfig("replies");
  const [pending, recent] = await Promise.all([listPendingReplies(db), listRecentlyConfirmedReplies(db, new Date(options.now.getTime() - config.panel.undo_days * DAY_MS))]);
  if (pending.length === 0 && recent.length === 0) return null;
  const [links, format] = await Promise.all([listReplyLinkOptions(db, config.match.candidate_statuses), getFormatter()]);
  const view = (row: ReplyListRow): ReplyView => ({
    id: row.id,
    subject: row.subject,
    quote: row.quote,
    senderDomain: row.senderDomain,
    receivedLabel: format.dateTime(row.receivedAt, { dateStyle: "medium", timeZone: options.timezone }),
    suspiciousInstruction: row.suspiciousInstruction,
    category: row.category,
    match: row.match,
    jobId: row.jobId,
    company: row.company,
    title: row.title,
    candidateJobIds: row.candidates.map((candidate) => candidate.jobId),
    suggestion: row.suggestion,
  });
  return { pending: pending.map(view), recent: recent.map(view), links: links.map(({ jobId, company, title }) => ({ jobId, company, title })) };
}
