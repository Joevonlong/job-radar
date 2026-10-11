import { eq, isNull, and } from "drizzle-orm";

import type { Db } from "../client";
import { notifications } from "../schema";

export type AlertRow = typeof notifications.$inferSelect;

/**
 * Queue an operational alert (e.g. `alert.backup_failed`) as an unsent `notifications` row. Nothing
 * sends it until the Telegram push picks up rows whose `sent_at` is null.
 */
export async function enqueueAlert(db: Db, input: { kind: string; payload?: unknown }): Promise<AlertRow> {
  const [row] = await db
    .insert(notifications)
    .values({ kind: input.kind, payloadJson: input.payload ?? null })
    .returning();
  if (!row) throw new Error("enqueueAlert: insert returned no row");
  return row;
}

/** Unsent alerts of one kind, oldest first. */
export async function listPendingAlerts(db: Db, kind: string): Promise<AlertRow[]> {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.kind, kind), isNull(notifications.sentAt)))
    .orderBy(notifications.id);
}
