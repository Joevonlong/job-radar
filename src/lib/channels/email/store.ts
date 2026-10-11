import type { Db } from "@/lib/db/client";
import { findProcessedMessageIds, recordEmailMessages, type EmailMessageInput } from "@/lib/db/repos/email-messages";

/** What the channel remembers between cycles: which Message-IDs it already handled. */
export interface EmailStore {
  findProcessed(messageIds: readonly string[]): Promise<Set<string>>;
  record(rows: readonly EmailMessageInput[]): Promise<void>;
}

/** Store backed by `email_messages`. */
export function createDbEmailStore(db: Db): EmailStore {
  return {
    findProcessed: (ids) => findProcessedMessageIds(db, ids),
    record: (rows) => recordEmailMessages(db, rows),
  };
}

/** In-memory store for unit tests. */
export function createMemoryEmailStore(): EmailStore & { rows: Map<string, EmailMessageInput> } {
  const rows = new Map<string, EmailMessageInput>();
  return {
    rows,
    async findProcessed(ids) {
      return new Set(ids.filter((id) => rows.has(id)));
    },
    async record(input) {
      for (const row of input) if (!rows.has(row.messageId)) rows.set(row.messageId, row);
    },
  };
}
