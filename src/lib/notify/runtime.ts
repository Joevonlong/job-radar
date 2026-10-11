import type { ChannelLogger } from "@/lib/channels/types";
import type { NotifyConfig } from "@/lib/config";
import { checkCredentialEndpoint } from "@/lib/credential-endpoints";
import { loadTelegramEnv, parseAllowedUserIds } from "@/lib/env";

import { createTelegramClient, type TelegramClient, type TelegramFetch } from "./telegram-client";

/** A client plus the chat it talks to. */
export interface TelegramRuntime {
  client: TelegramClient;
  chatId: string;
  /** `TELEGRAM_ALLOWED_USER_IDS`: only these users' button presses count. null (unset): everyone in the chat. */
  allowedUserIds?: readonly number[] | null;
}

export interface RuntimeOptions {
  config: NotifyConfig;
  logger: ChannelLogger;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: TelegramFetch;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Build the Bot API client from `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Returns null (and logs
 * why, without the values) when Telegram is not configured or the variables are malformed.
 */
export function createTelegramRuntime(options: RuntimeOptions): TelegramRuntime | null {
  let env;
  try {
    env = loadTelegramEnv(options.env ?? process.env);
  } catch (error) {
    options.logger.error("telegram credentials are invalid", { error: error instanceof Error ? error.message : "unknown error" });
    return null;
  }
  if (env === null) {
    if (options.config.telegram.enabled) options.logger.warn("telegram is enabled but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set");
    return null;
  }
  const { telegram } = options.config;
  // The bot token is part of every request URL: it goes only to the Bot API's own host unless the user opted in.
  const endpoint = checkCredentialEndpoint("telegram", telegram.api_base_url, options.env ?? process.env);
  if (endpoint.status === "refused") {
    options.logger.error("telegram is not used: custom api_base_url refused", { reason: endpoint.message });
    return null;
  }
  if (endpoint.status === "custom") options.logger.warn("telegram uses a custom api_base_url", { reason: endpoint.message });
  const client = createTelegramClient({
    token: env.TELEGRAM_BOT_TOKEN,
    baseUrl: telegram.api_base_url,
    requestTimeoutMs: telegram.request_timeout_seconds * 1000,
    maxRetries: telegram.max_retries,
    logger: options.logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { client, chatId: env.TELEGRAM_CHAT_ID, allowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS) };
}
