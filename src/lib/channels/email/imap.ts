import { ImapFlow } from "imapflow";

import { ChannelError } from "../errors";

/**
 * Read-only access to one Gmail label over IMAP (imapflow). The mailbox is opened with
 * `readOnly: true` (IMAP EXAMINE: the server refuses any flag change) and bodies are fetched with
 * BODY.PEEK, so nothing is marked read; this module has no code path that moves, flags or deletes.
 */

export interface MailHeader {
  uid: number;
  /** RFC 5322 Message-ID including the angle brackets; null when the message has none. */
  messageId: string | null;
  /** Address of the first From entry, "" when absent. */
  from: string;
  /** Display name of the first From entry; only some callers read it. */
  fromName?: string;
  subject: string;
  receivedAt: Date;
  /** Gmail's conversation id (X-GM-THRID); absent on servers without threads. */
  threadId?: string;
  /** RFC 5322 In-Reply-To of the message. */
  inReplyTo?: string;
  /** UIDVALIDITY of the mailbox: a UID is only meaningful together with it. */
  uidValidity?: string;
}

export interface MailSession {
  /** Headers of the messages received on or after `since`, newest first. */
  listSince(since: Date): Promise<MailHeader[]>;
  /** The raw RFC 822 message, null when it is gone. */
  fetchSource(uid: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** Mailbox (Gmail label) to open. */
  label: string;
  /** Where the label is configured, named when it does not exist. Default: the alert channel's `sources.gmail.label`. */
  labelSetting?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type MailSessionFactory = (options: ImapConnectOptions) => Promise<MailSession>;

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ETIMEOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "NoConnection", "ConnectionClosed"]);

interface ImapErrorLike {
  code?: unknown;
  authenticationFailed?: unknown;
  mailboxMissing?: unknown;
  responseStatus?: unknown;
  serverResponseCode?: unknown;
}

/** Classify an imapflow failure. Messages carry the error code only: server text can echo the login. */
export function classifyImapError(error: unknown, labelSetting = "sources.gmail.label"): ChannelError {
  if (error instanceof ChannelError) return error;
  const e: ImapErrorLike = typeof error === "object" && error !== null ? error : {};
  const code = typeof e.code === "string" ? e.code : typeof e.serverResponseCode === "string" ? e.serverResponseCode : undefined;
  if (e.authenticationFailed === true || code === "AUTHENTICATIONFAILED") {
    return new ChannelError("auth_expired", "Gmail rejected the login (check GMAIL_USER and the app password)", { cause: error });
  }
  if (e.mailboxMissing === true || code === "NONEXISTENT") {
    return new ChannelError("unknown", `the configured Gmail label does not exist (${labelSetting})`, { retryable: false, cause: error });
  }
  if (code !== undefined && NETWORK_CODES.has(code)) return new ChannelError("network", `IMAP connection failed (${code})`, { cause: error });
  const label = code ? ` (${code})` : "";
  return new ChannelError("network", `IMAP request failed${label}`, { cause: error });
}

/** Connect to Gmail and open the label read-only. */
export const openImapSession: MailSessionFactory = async (options) => {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: options.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
  });
  // without a listener an 'error' event (dropped socket) would crash the process
  client.on("error", () => undefined);
  const abort = (): void => client.close();
  options.signal.addEventListener("abort", abort, { once: true });

  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  const shutdown = async (): Promise<void> => {
    options.signal.removeEventListener("abort", abort);
    try {
      lock?.release();
    } catch {
      // the connection is going away anyway
    }
    lock = null;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  };

  try {
    await client.connect();
    lock = await client.getMailboxLock(options.label, { readOnly: true });
  } catch (error) {
    await shutdown();
    throw classifyImapError(error, options.labelSetting);
  }

  return {
    async listSince(since) {
      try {
        const uids = await client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const mailbox = client.mailbox;
        const uidValidity = mailbox && mailbox.uidValidity !== undefined ? String(mailbox.uidValidity) : undefined;
        const headers: MailHeader[] = [];
        for await (const message of client.fetch(uids, { uid: true, envelope: true, internalDate: true, threadId: true }, { uid: true })) {
          const envelope = message.envelope;
          const date = message.internalDate ?? envelope?.date;
          const receivedAt = date instanceof Date ? date : date ? new Date(date) : new Date(0);
          headers.push({
            uid: message.uid,
            messageId: envelope?.messageId?.trim() || null,
            from: envelope?.from?.[0]?.address?.trim() ?? "",
            fromName: envelope?.from?.[0]?.name?.trim() ?? "",
            subject: envelope?.subject?.trim() ?? "",
            receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date(0) : receivedAt,
            ...(message.threadId ? { threadId: String(message.threadId) } : {}),
            ...(envelope?.inReplyTo ? { inReplyTo: envelope.inReplyTo.trim() } : {}),
            ...(uidValidity === undefined ? {} : { uidValidity }),
          });
        }
        return headers.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.uid - a.uid);
      } catch (error) {
        throw classifyImapError(error, options.labelSetting);
      }
    },
    async fetchSource(uid) {
      try {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        return message && message.source ? message.source : null;
      } catch (error) {
        throw classifyImapError(error, options.labelSetting);
      }
    },
    close: shutdown,
  };
};
