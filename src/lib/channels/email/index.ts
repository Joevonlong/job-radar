import { getDb } from "@/lib/db/client";

import type { ChannelRegistry } from "../registry";
import { createGmailAlertsChannel, type GmailAlertsOptions } from "./channel";
import { createDbEmailStore } from "./store";

export { createGmailAlertsChannel, GMAIL_ALERTS_ID, GMAIL_APP_PASSWORD_ENV, GMAIL_USER_ENV, type GmailAlertsOptions } from "./channel";
export { classifyImapError, openImapSession, type ImapConnectOptions, type MailHeader, type MailSession, type MailSessionFactory } from "./imap";
export { parseEmailPayload } from "./payload";
export { PARSERS, platformOfSender } from "./parsers";
export { createDbEmailStore, createMemoryEmailStore, type EmailStore } from "./store";
export type { AlertJob, AlertParser } from "./types";

/** Registers `gmail-alerts`; the database is only touched in real runs. */
export function registerEmailChannels(registry: ChannelRegistry, options: Partial<GmailAlertsOptions> = {}): void {
  registry.register(createGmailAlertsChannel({ store: () => createDbEmailStore(getDb()), ...options }));
}
