import { simpleParser } from "mailparser";

import type { ChannelLogger } from "@/lib/channels/types";
import { ChannelError, isAbortError } from "@/lib/channels/errors";
import { GMAIL_APP_PASSWORD_ENV, GMAIL_USER_ENV } from "@/lib/channels/email/channel";
import { classifyImapError, openImapSession, type MailHeader, type MailSession, type MailSessionFactory } from "@/lib/channels/email/imap";
import { readMessage } from "@/lib/channels/email/message";
import { loadConfig, type ChannelsConfig } from "@/lib/config";
import type { RepliesConfig } from "@/lib/config/schemas/replies";
import { checkImapEndpoint } from "@/lib/credential-endpoints";
import { registerCycleStep, type CycleStepFn } from "@/lib/cycle/steps";
import type { Db } from "@/lib/db/client";
import { findKnownReplyKeys, listConfirmedThreads, listReplyCandidates, pruneDecidedReplies, saveReply, type ReplyInput } from "@/lib/db/repos/replies";
import { setRuntimeState } from "@/lib/db/repos/runtime-state";
import { loadPipeline } from "@/lib/market";
import { readTrapsSettings } from "@/lib/traps/settings";

import { classifyReply, quoteOf } from "./classify";
import { domainOfAddress, matchReply } from "./match";
import { cleanHeader, hasSuspiciousInstruction, messageHasInstruction, visibleBody } from "./sanitize";
import { needsDecision, suggestFor } from "./suggest";
import type { MatchCandidate, ConfirmedThread, ReplyCategory, ReplyMatch } from "./types";

const DAY_MS = 86_400_000;
/** Where `pnpm run doctor` reads when the label was last read. */
export const REPLIES_LAST_READ_KEY = "replies:last_read";
const LABEL_SETTING = "replies.yaml: label";

export interface ReplyRunResult {
  /** Messages in the window that were not handled before. */
  fresh: number;
  /** Read this run (at most `max_messages_per_cycle`). */
  read: number;
  stored: number;
  /** Mail that could not be handled: logged by uid, tried again next cycle, and it holds nothing else up. */
  failed: number;
  /** Over `max_message_bytes`: judged by its headers only, nothing downloaded. */
  oversized: number;
  /** From the mailbox's own address (Gmail labels a whole thread, sent mail included): not a reply. */
  ownSkipped: number;
  categories: Partial<Record<ReplyCategory, number>>;
  matches: Partial<Record<ReplyMatch, number>>;
  /** The connection dropped: what was read is kept, the rest waits for the next cycle. */
  stoppedEarly: boolean;
}

export interface ReadRepliesOptions {
  config: RepliesConfig;
  gmail: ChannelsConfig["sources"]["gmail"];
  /** Anything that answers `findKnown`, candidates and threads; `null` writes nothing and reads no state (a local preview with no database). */
  db: Db | null;
  /** false: the preview of `pnpm replies:check`, which stores nothing. */
  write: boolean;
  legalSuffixes: readonly string[];
  logger: ChannelLogger;
  signal: AbortSignal;
  now: () => Date;
  connect?: MailSessionFactory;
  environment?: Readonly<Record<string, string | undefined>>;
}

export function mailboxCredentials(environment: Readonly<Record<string, string | undefined>> = process.env): { user: string; password: string } | null {
  const user = environment[GMAIL_USER_ENV]?.trim();
  const password = environment[GMAIL_APP_PASSWORD_ENV]?.replace(/\s+/g, "");
  return user && password ? { user, password } : null;
}

const dedupeKeyOf = (header: MailHeader): string => (header.messageId === null ? "" : cleanHeader(header.messageId)) || `${header.uidValidity ?? "0"}:${header.uid}`;

/** One message, from source to the row that is stored. Pure apart from what it is given. */
export async function replyInputOf(input: {
  header: Pick<MailHeader, "uid" | "from" | "fromName" | "subject" | "receivedAt" | "messageId" | "threadId" | "uidValidity">;
  source: Buffer;
  config: RepliesConfig;
  candidates: readonly MatchCandidate[];
  threads: readonly ConfirmedThread[];
  legalSuffixes: readonly string[];
  now: Date;
}): Promise<ReplyInput> {
  const { header, config, now } = input;
  const traps = readTrapsSettings();
  let message: { html: string | null; text: string | null } = { html: null, text: null };
  try {
    message = await readMessage(input.source);
  } catch {
    // an undecodable mail is still a mail: it stays unclassified, and the user sees it
  }
  const visible = visibleBody(message);
  const body = visible.slice(0, config.body_scan_chars);
  const subject = cleanHeader(header.subject);
  const classified = classifyReply({ subject, body }, config.categories, config.storage.quote_max_chars);
  const senderDomain = cleanHeader(domainOfAddress(header.from));
  const threadId = header.threadId === undefined ? null : cleanHeader(header.threadId) || null;
  const matched = matchReply(
    { category: classified.category, senderAddress: cleanHeader(header.from), senderName: cleanHeader(header.fromName ?? ""), senderDomain, subject, body, threadId, receivedAt: header.receivedAt },
    input.candidates,
    input.threads,
    config.match,
    input.legalSuffixes,
  );
  const status = matched.applicationId === null ? null : (input.candidates.find((c) => c.applicationId === matched.applicationId)?.status ?? null);
  const suggestion = suggestFor(classified.category, status, config.transitions, header.receivedAt);
  const waits = needsDecision({ category: classified.category, match: matched.match, suggestion });
  return {
    dedupeKey: dedupeKeyOf(header as MailHeader),
    messageId: header.messageId === null ? null : cleanHeader(header.messageId) || null,
    threadId,
    senderDomain,
    receivedAt: header.receivedAt,
    rawRef: `imap:${config.label}#uidvalidity=${header.uidValidity ?? "0"};uid=${header.uid}`,
    subject: subject === "" ? null : subject.slice(0, config.storage.subject_max_chars),
    quote: quoteOf(classified.evidence, body, config.storage.quote_max_chars),
    suspiciousInstruction: hasSuspiciousInstruction(subject, traps) || messageHasInstruction(message, visible, traps),
    category: classified.category,
    match: matched.match,
    applicationId: matched.applicationId,
    jobId: matched.jobId,
    matchScore: matched.score,
    candidates: matched.candidates,
    suggestion,
    state: waits ? "pending" : "info",
    decidedAt: waits ? null : now,
  };
}

/**
 * One Gmail mailbox has many spellings: dots in the name do not count, and `name+anything` is the same box, at gmail.com or googlemail.com.
 * Only these two domains are folded (for any other host that is the provider's choice and cannot be told from here).
 */
export function canonicalMailbox(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  const domain = lower.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return lower;
  return `${lower.slice(0, at).split("+")[0]!.replaceAll(".", "")}@gmail.com`;
}

/** The rules on one local message (`pnpm replies:check --eml`): no mailbox, no database. */
export async function classifyEml(source: Buffer, config: RepliesConfig): Promise<{ category: ReplyCategory; suspiciousInstruction: boolean }> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, skipHtmlToText: true });
  const now = new Date();
  const row = await replyInputOf({ header: { uid: 0, from: parsed.from?.value[0]?.address ?? "", subject: parsed.subject ?? "", receivedAt: now, messageId: null }, source, config, candidates: [], threads: [], legalSuffixes: [], now });
  return { category: row.category, suspiciousInstruction: row.suspiciousInstruction };
}

/**
 * Open the one configured label read-only, read the mail not seen before (oldest first, so a long backlog drains in order), and store what the
 * rules make of it. Writes only `email_replies`: applications stay as they are until the user confirms (C3). Logs carry uids and counts, never
 * a subject, a sender or a word of a mail.
 */
export async function readReplies(options: ReadRepliesOptions): Promise<ReplyRunResult> {
  const { config, gmail, db, logger, signal } = options;
  const environment = options.environment ?? process.env;
  const credentials = mailboxCredentials(environment);
  if (!credentials) throw new ChannelError("auth_expired", `${GMAIL_USER_ENV} and ${GMAIL_APP_PASSWORD_ENV} must be set (see docs/gmail-replies.md)`);
  const endpoint = checkImapEndpoint(gmail.host, gmail.port, gmail.secure, environment);
  if (endpoint.status === "refused") throw new ChannelError("unknown", endpoint.message, { retryable: false });
  if (endpoint.status === "custom") logger.warn("replies: custom IMAP endpoint", { reason: endpoint.message });

  const connect = options.connect ?? openImapSession;
  let session: MailSession;
  try {
    session = await connect({ host: gmail.host, port: gmail.port, secure: gmail.secure, user: credentials.user, password: credentials.password, label: config.label, labelSetting: LABEL_SETTING, timeoutMs: gmail.timeout_ms, signal });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error;
    throw classifyImapError(error, LABEL_SETTING);
  }

  const result: ReplyRunResult = { fresh: 0, read: 0, stored: 0, failed: 0, oversized: 0, ownSkipped: 0, categories: {}, matches: {}, stoppedEarly: false };
  try {
    const now = options.now();
    const since = new Date(now.getTime() - config.lookback_days * DAY_MS);
    let listed: MailHeader[];
    try {
      listed = await session.listSince(since);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      throw classifyImapError(error, LABEL_SETTING);
    }
    const own = canonicalMailbox(credentials.user);
    const inWindow = listed.filter((header) => header.receivedAt.getTime() >= since.getTime());
    const headers = inWindow.filter((header) => canonicalMailbox(header.from) !== own);
    result.ownSkipped = inWindow.length - headers.length;
    const known = db ? await findKnownReplyKeys(db, headers.map(dedupeKeyOf)) : new Set<string>();
    const seen = new Set<string>();
    const fresh = headers
      .filter((header) => {
        const key = dedupeKeyOf(header);
        if (known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.uid - b.uid);
    result.fresh = fresh.length;
    // A mail that fails every cycle is never stored, so it is always "fresh" and, oldest first, would take a slot of the batch for good: only
    // mail that was read uses a slot. The window is twice the limit, so one cycle never works through a whole backlog of bad mail.
    const limit = config.max_messages_per_cycle;
    const batch = fresh.slice(0, limit * 2);
    const candidates = db ? await listReplyCandidates(db, config.match.candidate_statuses) : [];
    const threads = db ? await listConfirmedThreads(db, [...new Set(batch.flatMap((header) => (header.threadId ? [header.threadId] : [])))]) : [];

    for (const header of batch) {
      signal.throwIfAborted();
      if (result.read >= limit) break;
      const oversized = header.size !== undefined && header.size > config.max_message_bytes;
      let source: Buffer | null;
      try {
        source = oversized ? Buffer.alloc(0) : await session.fetchSource(header.uid);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        const failure = classifyImapError(error, LABEL_SETTING);
        if (result.read === 0) throw failure;
        logger.warn("replies: mailbox read stopped early", { code: failure.code, read: result.read });
        result.stoppedEarly = true;
        break;
      }
      if (!source) {
        logger.warn("replies: message disappeared before it could be read", { uid: header.uid });
        continue;
      }
      if (oversized) {
        result.oversized += 1;
        logger.warn("replies: message too large to download, judged by its headers", { uid: header.uid, bytes: header.size });
      }
      // one bad mail must not hold up the rest: the read is oldest first, so it would stop every cycle at the same message
      try {
        const row = await replyInputOf({ header, source, config, candidates, threads, legalSuffixes: options.legalSuffixes, now });
        if (options.write && db && (await saveReply(db, row))) result.stored += 1;
        result.read += 1;
        result.categories[row.category] = (result.categories[row.category] ?? 0) + 1;
        result.matches[row.match] = (result.matches[row.match] ?? 0) + 1;
        logger.info("replies: message read", { uid: header.uid, category: row.category, match: row.match });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        result.failed += 1;
        // the name only: a database error's message quotes the values, and those are the mail
        logger.warn("replies: message could not be handled", { uid: header.uid, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted || error instanceof ChannelError) throw error;
    // what is left here is the database; its message quotes the query's values, so it stays out
    throw new ChannelError("unknown", "replies: database request failed");
  } finally {
    await session.close();
  }
  return result;
}

export interface RepliesStepOptions {
  connect?: MailSessionFactory;
  environment?: Readonly<Record<string, string | undefined>>;
}

/** The cycle step `replies`. Off or without mailbox credentials it records why and does nothing else; a failure only fails this step (C2). */
export function createRepliesStep(options: RepliesStepOptions = {}): CycleStepFn {
  return async (ctx) => {
    const db = ctx.db;
    if (!db) return { result: { skipped: "no_database" } };
    const config = loadConfig("replies");
    const cleared = await pruneDecidedReplies(db, new Date(ctx.now().getTime() - config.storage.decided_retention_days * DAY_MS));
    if (!config.enabled) return { result: { skipped: "disabled", cleared } };
    if (!mailboxCredentials(options.environment ?? process.env)) return { result: { skipped: "not_configured", cleared } };
    const outcome = await readReplies({
      config,
      gmail: ctx.config.channels.sources.gmail,
      db,
      write: true,
      legalSuffixes: loadPipeline().company.legal_suffixes,
      logger: ctx.logger,
      signal: ctx.signal,
      now: ctx.now,
      ...(options.connect ? { connect: options.connect } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    await setRuntimeState(db, REPLIES_LAST_READ_KEY, { at: ctx.now().toISOString() });
    return { status: outcome.stoppedEarly || outcome.failed > 0 ? "partial" : "ok", result: { ...outcome, cleared } };
  };
}

export function registerRepliesStep(options: RepliesStepOptions = {}): void {
  registerCycleStep("replies", createRepliesStep(options));
}
