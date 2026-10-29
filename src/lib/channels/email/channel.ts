import { createHash } from "node:crypto";

import { gmailSettingsSchema, type GmailSettings } from "@/lib/config";
import { checkImapEndpoint } from "@/lib/credential-endpoints";
import type { EmailMessageInput } from "@/lib/db/repos/email-messages";

import { ChannelError, isAbortError } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { classifyImapError, openImapSession, type MailHeader, type MailSession, type MailSessionFactory } from "./imap";
import { readMessage } from "./message";
import { jobExternalId, jobPayload, parseEmailPayload, unparsedExternalId, type EmailUnparsedPayload } from "./payload";
import { PARSERS, platformOfSender } from "./parsers";
import type { EmailStore } from "./store";

export const GMAIL_ALERTS_ID = "gmail-alerts";
export const GMAIL_USER_ENV = "GMAIL_USER";
export const GMAIL_APP_PASSWORD_ENV = "GMAIL_APP_PASSWORD";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GmailAlertsOptions {
  /** Opens the mailbox. Default: imapflow against Gmail (tests pass a fake session). */
  connect?: MailSessionFactory;
  /** Handled-message storage; only asked for in real runs (dry runs neither read nor write it). */
  store: () => EmailStore;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

function readSettings(ctx: ChannelContext): GmailSettings {
  const parsed = gmailSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml sources.gmail is invalid (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/** Message-ID of a header; a stable synthetic id for the rare message without one. */
function messageIdOf(header: MailHeader): string {
  if (header.messageId) return header.messageId;
  const digest = createHash("sha256").update(`${header.from}|${header.receivedAt.toISOString()}|${header.subject}`).digest("hex").slice(0, 32);
  return `<no-message-id:${digest}@job-radar.invalid>`;
}

interface MessageOutcome {
  record: EmailMessageInput;
  postings: RawPostingInput[];
}

/**
 * `gmail-alerts`: the job-alert emails LinkedIn, StepStone, Indeed and XING send to the
 * user's Gmail. Reads one label read-only (never marks, moves or deletes), picks the parser by sender
 * domain, and turns each job card into a raw posting. An email whose layout no parser recognises is
 * stored whole as an `email_unparsed` raw posting (the pipeline marks it `parse_failed`) so nothing
 * is lost (C1); it never stops the other emails (C2). Handled Message-IDs are kept in
 * `email_messages`, so a message is read once.
 */
export function createGmailAlertsChannel(options: GmailAlertsOptions): Channel {
  const connect = options.connect ?? openImapSession;
  const now = options.now ?? (() => new Date());

  async function processMessage(
    session: MailSession,
    header: MailHeader,
    messageId: string,
    settings: GmailSettings,
    ctx: ChannelContext,
  ): Promise<MessageOutcome | null> {
    const record = (parseStatus: EmailMessageInput["parseStatus"]): EmailMessageInput => ({
      messageId,
      sender: header.from || "(unknown)",
      receivedAt: header.receivedAt,
      parseStatus,
      rawRef: `imap:${settings.label}#uid=${header.uid}`,
    });

    const platform = platformOfSender(header.from, settings.senders);
    if (!platform) {
      // not one of the four platforms: a stray mail in the label is neither read nor stored
      ctx.logger.warn("email from an unknown sender skipped", { uid: header.uid });
      return { record: record("parse_failed"), postings: [] };
    }

    const source = await session.fetchSource(header.uid);
    if (!source) {
      ctx.logger.warn("email disappeared before it could be read", { uid: header.uid });
      return null; // not recorded: it may reappear
    }

    const failure = (reason: string, html: string | null, text: string | null): MessageOutcome => {
      ctx.logger.warn("email could not be parsed", { platform, uid: header.uid, reason });
      const payload: EmailUnparsedPayload = {
        kind: "email_unparsed",
        platform,
        messageId,
        sender: header.from,
        subject: header.subject,
        receivedAt: header.receivedAt.toISOString(),
        reason,
        // an unreadable message is kept as the server delivered it
        html: html ?? (text === null ? source.toString("utf8") : null),
        text,
      };
      return { record: record("parse_failed"), postings: [{ externalId: unparsedExternalId(messageId), url: null, payload }] };
    };

    let html: string | null = null;
    let text: string | null = null;
    try {
      ({ html, text } = await readMessage(source));
    } catch (error) {
      return failure(`message could not be decoded (${error instanceof Error ? error.name : "error"})`, null, null);
    }
    if (html === null) return failure("no HTML part", null, text);

    let jobs;
    try {
      jobs = PARSERS[platform].parse(html);
    } catch (error) {
      return failure(`${platform} parser threw (${error instanceof Error ? error.name : "error"})`, html, text);
    }
    if (jobs.length === 0) return failure(`no ${platform} job cards recognised`, html, text);

    const postings: RawPostingInput[] = jobs.map((job) => ({
      externalId: jobExternalId(platform, job),
      url: job.url,
      payload: jobPayload(platform, job),
      postedAt: null,
    }));
    ctx.logger.info("alert email parsed", { platform, uid: header.uid, jobs: postings.length });
    return { record: record("parsed"), postings };
  }

  return {
    id: GMAIL_ALERTS_ID,
    family: "email",
    kind: "email",
    usesQueries: false,
    // ignores the search window: a stretched window fetches nothing more and would only mark its runs as extended
    supportsCatchUp: () => false,
    // without the mailbox credentials the channel is "not configured": skipped, not a failed run
    isConfigured: () => {
      const env = options.environment ?? process.env;
      return (env[GMAIL_USER_ENV] ?? "").trim() !== "" && (env[GMAIL_APP_PASSWORD_ENV] ?? "").replace(/\s+/g, "") !== "";
    },

    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = readSettings(ctx);
      const env = options.environment ?? process.env;
      const user = env[GMAIL_USER_ENV]?.trim();
      const password = env[GMAIL_APP_PASSWORD_ENV]?.replace(/\s+/g, "");
      if (!user || !password) {
        throw new ChannelError("auth_expired", `${GMAIL_USER_ENV} and ${GMAIL_APP_PASSWORD_ENV} must be set (see docs/gmail-alerts.md)`);
      }
      // the Gmail login goes only to imap.gmail.com:993 over TLS unless the user opted in
      const endpoint = checkImapEndpoint(settings.host, settings.port, settings.secure, env);
      if (endpoint.status === "refused") throw new ChannelError("unknown", endpoint.message, { retryable: false });
      if (endpoint.status === "custom") ctx.logger.warn("gmail-alerts: custom IMAP endpoint", { reason: endpoint.message });
      // dry runs (no cycle id) write nothing and must show what a real run would read, so they skip the handled-message list
      const store = ctx.cycle.id === null ? null : options.store();
      const cap = Math.min(query.maxResults, ctx.settings.maxResults);

      let session: MailSession;
      try {
        session = await connect({
          host: settings.host,
          port: settings.port,
          secure: settings.secure,
          user,
          password,
          label: settings.label,
          timeoutMs: settings.timeout_ms,
          signal: ctx.signal,
        });
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw error;
        throw classifyImapError(error);
      }

      const postings: RawPostingInput[] = [];
      const records: EmailMessageInput[] = [];
      let attempted = 0;
      let abortedEarly: ChannelError | null = null;
      try {
        const since = new Date(now().getTime() - settings.lookback_days * DAY_MS);
        const headers = (await session.listSince(since)).filter((h) => h.receivedAt.getTime() >= since.getTime());
        const identified = headers.map((header) => ({ header, messageId: messageIdOf(header) }));
        const handled = store ? await store.findProcessed(identified.map((i) => i.messageId)) : new Set<string>();
        const seen = new Set<string>();
        const fresh = identified.filter(({ messageId }) => {
          if (handled.has(messageId) || seen.has(messageId)) return false;
          seen.add(messageId);
          return true;
        });
        const batch = fresh.slice(0, settings.max_messages_per_cycle);
        ctx.logger.info("mailbox listed", { label: settings.label, inWindow: headers.length, alreadyHandled: handled.size, reading: batch.length, waiting: fresh.length - batch.length });

        for (const { header, messageId } of batch) {
          ctx.signal.throwIfAborted();
          // the posting cap is soft: a message is never cut in half, otherwise its remaining jobs would be lost
          if (postings.length >= cap) {
            ctx.logger.warn("posting cap reached; remaining emails wait for the next cycle", { cap });
            break;
          }
          attempted += 1;
          try {
            const outcome = await processMessage(session, header, messageId, settings, ctx);
            if (outcome) {
              records.push(outcome.record);
              postings.push(...outcome.postings);
            }
          } catch (error) {
            if (isAbortError(error) || ctx.signal.aborted) throw error;
            const failure = classifyImapError(error);
            // the connection is gone: keep what was read, the rest waits for the next cycle
            if (records.length === 0) throw failure;
            abortedEarly = failure;
            break;
          }
        }
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw error;
        throw classifyImapError(error);
      } finally {
        await session.close();
      }
      if (abortedEarly) ctx.logger.warn("mailbox read stopped early", { code: abortedEarly.code, read: records.length, attempted });

      if (store && records.length > 0) await store.record(records);
      ctx.logger.info("gmail alerts done", { emails: records.length, postings: postings.length, dryRun: store === null });
      return postings;
    },

    parse: parseEmailPayload,
  };
}
