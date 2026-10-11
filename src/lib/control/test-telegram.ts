/**
 * `test_telegram`: the "send a Telegram test message" button of /settings, the web version of
 * `pnpm telegram:test`. Claimed by the runner, which has the bot credentials (it sends the alerts). Works while
 * `notify.yaml: telegram.enabled` is still false. Only an error code goes into the result, never the token (C4).
 */
import { loadConfig, type NotifyConfig } from "@/lib/config";
import { createTelegramRuntime, type TelegramRuntime } from "@/lib/notify/runtime";
import { isTelegramError } from "@/lib/notify/telegram-client";
import { sendTestMessage } from "@/lib/notify/test-message";

import { testTelegramPayloadSchema, type ControlHandler } from "./types";

export interface TestTelegramDeps {
  config?: NotifyConfig;
  /** Builds the bot client; default: from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. null = not configured. */
  runtime?: (config: NotifyConfig, signal: AbortSignal) => TelegramRuntime | null;
}

export function createTestTelegramHandler(deps: TestTelegramDeps = {}): ControlHandler {
  return async (request, context) => {
    if (!testTelegramPayloadSchema.safeParse(request.payload ?? {}).success) return { status: "failed", result: { error: "invalid_payload" } };
    const loaded = deps.config ?? loadConfig("notify");
    // `enabled` is irrelevant for a test message: pretend it is on so a missing credential is reported
    const config: NotifyConfig = { ...loaded, telegram: { ...loaded.telegram, enabled: true } };
    const runtime = deps.runtime ? deps.runtime(config, context.signal) : createTelegramRuntime({ config, logger: context.logger, signal: context.signal });
    if (runtime === null) return { status: "failed", result: { error: "telegram_not_configured" } };
    try {
      const sent = await sendTestMessage(runtime);
      context.logger.info("telegram test message sent", { messageId: sent.messageId });
      return { status: "done", result: { messageId: sent.messageId, bot: sent.botUsername } };
    } catch (error) {
      if (context.signal.aborted) throw error;
      const errorKind = isTelegramError(error) ? error.kind : "unknown";
      const status = isTelegramError(error) ? error.status : null;
      context.logger.warn("telegram test message failed", { kind: errorKind, status });
      return { status: "failed", result: { error: "telegram_failed", errorKind, ...(status === null ? {} : { httpStatus: status }) } };
    }
  };
}

export const testTelegramHandler: ControlHandler = createTestTelegramHandler();
