/**
 * Send one test message through the Telegram bot.
 *
 *   pnpm telegram:test
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment (`.env` is loaded by the pnpm
 * script) and notify.yaml's `telegram.api_base_url`. Works while `telegram.enabled` is still false.
 * Never prints the token. Exit code 2 when the variables are missing or malformed, 1 when Telegram
 * rejects the request.
 */
import { createLogger } from "../src/lib/channels/logger";
import { loadConfig } from "../src/lib/config";
import { createTelegramRuntime } from "../src/lib/notify/runtime";
import { sendTestMessage } from "../src/lib/notify/test-message";
import { isTelegramError } from "../src/lib/notify/telegram-client";

async function main(): Promise<number> {
  const logger = createLogger({ minLevel: "error" });
  // `enabled` is irrelevant for a test message; pretend it is on so a missing credential is reported
  const config = loadConfig("notify");
  const runtime = createTelegramRuntime({ config: { ...config, telegram: { ...config.telegram, enabled: true } }, logger });
  if (runtime === null) {
    console.error("telegram:test: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (see docs/telegram.md)");
    return 2;
  }
  try {
    const result = await sendTestMessage(runtime);
    console.log(`telegram:test: sent message ${result.messageId} via bot ${result.botUsername ? `@${result.botUsername}` : "(no username)"}`);
    return 0;
  } catch (error) {
    console.error(`telegram:test: ${isTelegramError(error) ? error.message : "unexpected error"}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`telegram:test: ${error instanceof Error ? error.name : "unexpected error"}`);
    process.exit(1);
  },
);
