import { noopRecorder, spanScope } from "@/lib/activity";
import { listStaleApplications } from "@/lib/db/repos/applications";
import { getLastNotificationAt, NOTIFICATION_KINDS, recordNotification } from "@/lib/db/repos/notifications";

import { formatReminders, type ReminderSection } from "./format";
import { isTelegramError } from "./telegram-client";
import { notifyText } from "./text";
import { isQuietHours, isReminderDue } from "./time";
import type { NotifyDeps } from "./types";

/**
 * The daily application reminder: "interested" for more than N days without
 * applying, "applied" for more than M days without an answer. One message per local day at
 * `reminders.send_at` (or later the same day if the runner was down); a day with nothing due is
 * recorded as `{ empty: true }` so it is not re-checked all day.
 */

export type ReminderOutcome = "disabled" | "not_due" | "quiet" | "empty" | "sent" | "failed";

const DAY_MS = 86_400_000;

export async function runReminders(deps: NotifyDeps): Promise<ReminderOutcome> {
  const { config } = deps;
  if (!config.reminders.enabled) return "disabled";
  const now = deps.now();
  const last = await getLastNotificationAt(deps.db, NOTIFICATION_KINDS.reminder);
  if (!isReminderDue({ now, timeZone: deps.timeZone, sendAt: config.reminders.send_at, lastHandledAt: last })) return "not_due";
  if (isQuietHours(now, deps.timeZone, config.quiet_hours)) return "quiet";

  const { interested_days, applied_days, max_items } = config.reminders;
  const [interested, applied] = await Promise.all([
    listStaleApplications(deps.db, { status: "interested", before: new Date(now.getTime() - interested_days * DAY_MS), limit: max_items }),
    listStaleApplications(deps.db, { status: "applied", before: new Date(now.getTime() - applied_days * DAY_MS), limit: max_items }),
  ]);
  const span = (deps.activity ?? noopRecorder).systemRoot("system.reminder");
  const scope = spanScope(span);
  try {
    span.note("info", "reminder_counts", { interested: interested.total, applied: applied.total });
    const text = deps.text ?? notifyText();
    const sections: ReminderSection[] = [
      { heading: text.t("reminders.interested", { days: interested_days }), total: interested.total, items: interested.items },
      { heading: text.t("reminders.applied", { days: applied_days }), total: applied.total, items: applied.items },
    ];

    if (interested.total === 0 && applied.total === 0) {
      await recordNotification(deps.db, { kind: NOTIFICATION_KINDS.reminder, payload: { empty: true }, sentAt: now });
      scope.set("ok");
      return "empty";
    }
    try {
      const message = await deps.client.sendMessage({ chatId: deps.chatId, text: formatReminders({ sections, now, publicBaseUrl: config.public_base_url }, text) });
      await recordNotification(deps.db, {
        kind: NOTIFICATION_KINDS.reminder,
        payload: { interested: interested.total, applied: applied.total },
        sentAt: deps.now(),
        telegramMessageId: message.messageId,
      });
      scope.set("ok");
      return "sent";
    } catch (error) {
      scope.error(error);
      deps.logger.warn("reminder could not be sent", { error: isTelegramError(error) ? error.message : "unexpected error" });
      return "failed";
    }
  } catch (error) {
    scope.error(error);
    throw error;
  } finally { scope.close(); }
}

/**
 * `runReminders` for a loop that ticks often: after a failed send it waits `cooldownMs` before
 * trying again instead of retrying on every tick.
 */
export function createReminderTicker(cooldownMs: number): (deps: NotifyDeps) => Promise<ReminderOutcome> {
  let retryAt = 0;
  return async (deps) => {
    if (deps.now().getTime() < retryAt) return "not_due";
    const outcome = await runReminders(deps);
    if (outcome === "failed") retryAt = deps.now().getTime() + cooldownMs;
    return outcome;
  };
}
