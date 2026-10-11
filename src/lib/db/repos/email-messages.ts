import { inArray } from "drizzle-orm";

import type { Executor } from "../executor";
import { emailMessages } from "../schema";

export type EmailMessageRow = typeof emailMessages.$inferSelect;
export type EmailParseStatus = EmailMessageRow["parseStatus"];

export interface EmailMessageInput {
  /** RFC 5322 Message-ID (the primary key). */
  messageId: string;
  sender: string;
  receivedAt: Date;
  parseStatus: EmailParseStatus;
  /** Where the raw message lives (mailbox + UID); the body itself is not duplicated. */
  rawRef: string | null;
}

const CHUNK = 500;

/** Which of `messageIds` were processed before. */
export async function findProcessedMessageIds(db: Executor, messageIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const part = messageIds.slice(i, i + CHUNK);
    const rows = await db.select({ messageId: emailMessages.messageId }).from(emailMessages).where(inArray(emailMessages.messageId, part));
    for (const row of rows) found.add(row.messageId);
  }
  return found;
}

/** Remember processed messages. A message already on record keeps its first outcome. */
export async function recordEmailMessages(db: Executor, rows: readonly EmailMessageInput[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    await db.insert(emailMessages).values(part.map((r) => ({ ...r }))).onConflictDoNothing({ target: emailMessages.messageId });
  }
}
