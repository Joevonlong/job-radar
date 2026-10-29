import type { ActivityRecorder } from "@/lib/activity/types";
import type { ChannelLogger } from "@/lib/channels/types";
import type { NotifyConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

import type { TelegramClient } from "./telegram-client";
import type { NotifyText } from "./text";

/** What every sender (cycle step, alerts, reminders, poller) needs. */
export interface NotifyDeps {
  activity?: ActivityRecorder;
  db: Db;
  client: TelegramClient;
  /** The one chat messages go to and button presses are accepted from (`TELEGRAM_CHAT_ID`). */
  chatId: string;
  config: NotifyConfig;
  /** schedule.yaml time zone: quiet hours and the reminder time are local to it. */
  timeZone: string;
  now: () => Date;
  logger: ChannelLogger;
  /** The texts in the Telegram language (`notify.locale`); default: read from language.yaml when used. */
  text?: NotifyText;
  /** Waits between two messages of one batch (tests pass a no-op). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}
